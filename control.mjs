#!/usr/bin/env node
/**
 * Devin Agent Dispatcher - 管理サーバー
 *
 * dispatcher.mjs を子プロセスとして起動/停止し、
 * ブラウザ管理パネル (http://127.0.0.1:<port>/) から制御できるようにする。
 *
 * 常駐させるのはこのプロセス（タスクスケジューラ登録もこちらを対象にする）。
 * desired.json に enabled=true が残っていれば、次回起動時に dispatcher を自動起動する。
 *
 * API:
 *   GET  /              管理パネル HTML
 *   GET  /api/status    状態 { running, pid, startedAt, desired, config, tasks }
 *   GET  /api/log?n=200 dispatcher.log の末尾 n 行
 *   POST /api/start     dispatcher 起動（desired.enabled=true を永続化）
 *   POST /api/stop      dispatcher 停止（desired.enabled=false）
 *   POST /api/once      dispatcher が停止中のとき 1サイクルだけ実行
 *   POST /api/reload    config.json の読み直し（dispatcher 再起動は行わない）
 *
 * POST は `X-Panel: 1` ヘッダ必須（CSRF 対策。外部サイトのフォームからは送れない）。
 * 127.0.0.1 のみにバインドする。
 */
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, statSync, renameSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyOf, discover, toCandidate, readIssueStore } from './discover.mjs';
import { AcpChat } from './acp-chat.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(ROOT, 'config.json');
const DESIRED_PATH = join(ROOT, 'desired.json');
const STATE_PATH = join(ROOT, 'state.json');
const CANDS_PATH = join(ROOT, 'candidates.json');
const GOALS_PATH = join(ROOT, 'goals.json');
const ISSUES_PATH = join(ROOT, 'issues.json');
const SECRETS_PATH = join(ROOT, 'secrets.json'); // apiKey・MCP トークン等（gitignore 済。config.json へは書かない）
const LOG_PATH = join(ROOT, 'logs', 'dispatcher.log');
const PANEL_PATH = join(ROOT, 'panel.html');
// 判定カテゴリの自動処理しきい値: autoCategory までの判定を自動処理する
const CAT_ORDER = ['auto', 'review', 'human', 'reject'];
const catAllowed = (cat) =>
  CAT_ORDER.indexOf(cat) <= CAT_ORDER.indexOf(config.autoCategory ?? 'review');
// リスクの自動処理しきい値: maxAutoRisk までのリスクを自動処理する（判定とは AND）
const RISK_ORDER = ['low', 'medium', 'high'];
const riskAllowed = (risk) =>
  RISK_ORDER.indexOf(risk) <= RISK_ORDER.indexOf(config.maxAutoRisk ?? 'medium');

let config = loadJson(CONFIG_PATH, {});
let secrets = loadJson(SECRETS_PATH, {});
// 旧形式（config.json 内の apiKey）を secrets.json へ自動移行
if (config.apiKey) {
  if (!secrets.apiKey) secrets.apiKey = config.apiKey;
  delete config.apiKey;
  writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2) + '\n');
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  console.log('[control] config.json の apiKey を secrets.json へ移行しました');
}
// 手動編集で config.json に apiKey が残る場合も読み取りはする（次回保存時に移行）
const effectiveApiKey = () => secrets.apiKey ?? config.apiKey ?? '';
const HOST = '127.0.0.1';
const PORT = config.controlPort ?? 8585;
const PANEL_HEADER = ['x-panel', '1'];
const SELF_ORIGIN = `http://${HOST}:${PORT}`;

// CORS: 同一オリジン・file://(Origin: null)・ループバックの任意ポート
// （KASUGAI Canvas アプリ 8511/8510 等のローカルツール）・CDN ホスト版
// (GitHub Pages) を許可。https://evil.example 等の外部サイトからの読み書きは
// preflight/レスポンス読取でブロックされる。POST は別途 X-Panel ヘッダ必須
const EXTRA_ORIGINS = new Set(['https://yamamoto-ryuzo.github.io']);
function corsOrigin(req) {
  const o = req.headers.origin;
  if (!o) return null;
  if (o === 'null' || o === SELF_ORIGIN || EXTRA_ORIGINS.has(o)) return o;
  try {
    const u = new URL(o);
    const h = u.hostname.toLowerCase();
    if ((u.protocol === 'http:' || u.protocol === 'https:') &&
        (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]')) {
      return o;
    }
  } catch { /* invalid origin */ }
  return null;
}

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

// ---------- desired state ----------

function loadDesired() { return loadJson(DESIRED_PATH, { enabled: false }); }
function saveDesired(d) { writeFileSync(DESIRED_PATH, JSON.stringify(d, null, 2)); }

// ---------- child process management ----------

let child = null; // { proc, pid, startedAt, mode: 'loop'|'once' }
const manualRuns = new Map(); // task key -> pid（--task で起動した個別セッション）
// パネル内蔵チャット: devin.exe acp セッションを複数管理（並行評価/対応対応）
const chats = new Map(); // id -> {chat: AcpChat, label}
let chatSeq = 0;
function sessionsList() {
  return [...chats.entries()].map(([id, s]) => ({
    id, label: s.label, busy: s.chat.busy, ready: s.chat.ready,
    live: !!s.chat.proc, sessionId: s.chat.sessionId,
  }));
}
function pickChatId(label) {
  for (const [id, s] of chats) if (!s.chat.busy) { if (label) s.label = label; return id; }
  const id = ++chatSeq;
  chats.set(id, {
    chat: new AcpChat({ devinExe: config.devinExe, cwd: dirname(ROOT),
      getPersistedOptions: () => config.acpOptions ?? {} }),
    label: label ?? `session ${id}`,
  });
  return id;
}
// フェーズ別の上限（maxConcurrentAssess/Impl）を超えた送信は待機キューへ
const chatWait = []; // {key, mode, skill}
function busyCount(mode, isPr) {
  let n = 0;
  for (const s of chats.values()) {
    if (!s.chat.busy || !s.label.endsWith(' ' + mode)) continue;
    if (isPr === undefined || s.label.includes(' pr#') === isPr) n++;
  }
  return n;
}
function chatCapacity(mode, key) {
  // 同一リポジトリの impl（issue/pr 問わず）は同じ作業ツリーを使うため直列化。
  // 別枠の上限を個別に数えると issue と PR が同時起動して checkout/push が衝突する
  if (mode === 'impl' && key) {
    const repo = key.slice(0, key.indexOf(' '));
    for (const s of chats.values()) {
      if (s.chat.busy && s.label.endsWith(' impl') && s.label.startsWith(repo + ' ')) {
        return false;
      }
    }
  }
  const isPr = mode === 'impl' && key ? key.includes(' pr#') : undefined;
  const max = mode === 'assess'
    ? (config.maxConcurrentAssess ?? config.maxConcurrent ?? 1)
    : isPr === true
    ? (config.maxConcurrentPr ?? config.maxConcurrentImpl ?? config.maxConcurrent ?? 1)
    : (config.maxConcurrentImpl ?? config.maxConcurrent ?? 1);
  return busyCount(mode, isPr) < max;
}
// エンジン抽象層: devin=ACPチャット / copilot・antigravity=bridge-hub / api=汎用LLM(OpenAI互換)
async function engineSend(eng, prompt) {
  if (eng === 'api') {
    const url = (config.apiUrl || '').replace(/\/+$/, '');
    if (!url || !config.apiModel) throw new Error('apiUrl/apiModel 未設定');
    const r = await fetch(url + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        ...(effectiveApiKey() ? { Authorization: 'Bearer ' + effectiveApiKey() } : {}) },
      body: JSON.stringify({ model: config.apiModel,
        messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'api ' + r.status);
    return j.choices?.[0]?.message?.content || '';
  }
  // bridge-hub（CANVAS 方式: copilot/devin/antigravity を共通プロトコルで呼ぶ）
  const hub = (config.bridgeHub || 'http://127.0.0.1:8511').replace(/\/+$/, '');
  const r = await fetch(hub + '/agent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: eng, prompt,
      ...(config.bridgeModels?.[eng] ? { model: config.bridgeModels[eng] } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'bridge-hub ' + r.status);
  return j.reply || j.text || '';
}
// ---- エンジン解決（課題単位指定 → 全体設定）----
const ENGINES = ['devin', 'copilot', 'antigravity', 'api'];
const normEngine = (v) => {
  const e = String(v ?? '').trim().toLowerCase();
  return ENGINES.includes(e) ? e : null;
};
// issue/PR 側からの指定: ラベル "engine:<name>" → 本文行 "engine: <name>" の順に解釈
function issueEngine(key, issuesStore) {
  const it = (issuesStore ?? readIssueStore(ISSUES_PATH).issues)?.[key];
  if (!it) return null;
  for (const l of it.labels ?? []) {
    const m = String(l).match(/^engine\s*[:：]\s*(\S+)$/i);
    const e = m && normEngine(m[1]);
    if (e) return e;
  }
  const m = String(it.body ?? '').match(/^[ \t>]*engine\s*[:：]\s*([a-zA-Z]+)\s*$/im);
  return m ? normEngine(m[1]) : null;
}
// 解決優先順位: 呼出時の明示指定 > GitHub 側指定(ラベル/本文) > 課題保存指定(engineReq)
//             > モード別既定(config.engineModes) > config.engine > devin
function resolveEngine(key, mode, requested, tasksMap, issuesStore) {
  const tasks = tasksMap ?? loadJson(STATE_PATH, { tasks: {} }).tasks;
  return normEngine(requested)
    ?? issueEngine(key, issuesStore)
    ?? normEngine(tasks?.[key]?.engineReq)
    ?? normEngine(config.engineModes?.[mode])
    ?? normEngine(config.engine)
    ?? 'devin';
}
async function dispatchChatTask(key, mode, skill, engine) {
  const p = taskPrompt(key, mode, skill);
  if (p.text && config.extraPrompt) p.text += '\n\n【追加指示】\n' + config.extraPrompt;
  const eng = resolveEngine(key, mode, engine);
  // 実際に使われたエンジンを記録（パネル/ログで追跡）
  {
    const st = loadJson(STATE_PATH, { tasks: {} });
    st.tasks[key] = { ...(st.tasks[key] ?? {}),
      engineUsed: eng, engineUsedAt: new Date().toISOString() };
    writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
  }
  if (eng === 'api' && mode !== 'assess') {
    // api エンジンは単発テキスト応答のみ。impl/split は抑止（fatal=再キューしない）
    const st0 = loadJson(STATE_PATH, { tasks: {} });
    st0.tasks[key] = { ...(st0.tasks[key] ?? {}),
      note: 'api エンジンは評価専用のため ' + mode + ' を起動しませんでした' };
    writeFileSync(STATE_PATH, JSON.stringify(st0, null, 2));
    const e = new Error('api エンジンは評価(assess)専用です。impl/split は起動できません（devin/ブリッジ系を指定してください）');
    e.fatal = true;
    throw e;
  }
  if (eng !== 'devin') {
    // 非 devin エンジン: エンジン API に送信し、応答を疑似チャットとして watcher に渡す
    const id = 'eng' + (++chatSeq);
    const shim = { busy: true, ready: true, proc: true, sessionId: eng,
      messages: [], label: key + ' ' + mode };
    chats.set(id, { chat: shim, label: shim.label });
    engineSend(eng, p.text)
      .then((t) => { shim.messages.push({ role: 'agent', text: t || '' }); shim.busy = false; })
      .catch((e) => { shim.messages.push({ role: 'agent', text: '[engine error] ' + e.message }); shim.busy = false; });
    if (mode === 'assess') watchAssess(key, shim);
    if (mode === 'split') watchSplit(key, shim);
    if (mode === 'impl') watchImpl(key, shim);
    return id;
  }
  const id = pickChatId(key + ' ' + mode);
  await chats.get(id).chat.send(p.text);
  if (mode === 'assess') watchAssess(key, chats.get(id).chat);
  if (mode === 'split') watchSplit(key, chats.get(id).chat);
  if (mode === 'impl') watchImpl(key, chats.get(id).chat);
  return id;
}
setInterval(() => {
  // busy が立つ前に同じチャットを再選択しないよう await し、失敗時はキューへ戻す
  (async () => {
    for (let i = chatWait.length - 1; i >= 0; i--) {
      if (!chatCapacity(chatWait[i].mode, chatWait[i].key)) continue;
      const { key, mode, skill, engine } = chatWait.splice(i, 1)[0];
      try { await dispatchChatTask(key, mode, skill, engine); }
      catch (e) { if (!e?.fatal) chatWait.push({ key, mode, skill, engine }); }
    }
  })();
}, 3000).unref?.();

function taskPrompt(key, mode, skillFile) {
  const m = String(key ?? '').match(/^(\S+)\s+(issue|pr)#(\d+)$/);
  if (!m) return null;
  const repo = config.repos?.find((r) => r.github === m[1]);
  if (!repo) return { error: 'repo not monitored: ' + m[1] };
  const it = readIssueStore(ISSUES_PATH).issues?.[key] ?? {};
  let policy = '';
  for (const f of [m[1].split('/')[1], '_default']) {
    try { policy = readFileSync(join(ROOT, 'prompts', f + '.md'), 'utf8').trim(); break; }
    catch { /* next */ }
  }
  // skills/: モード別・完了時のカスタム指示を注入（_all/_assess/_impl/_split/_done.md）
  // skillFile 指定時はモード既定ではなくそのファイルを使う（パス走査防止の検証付き）
  const modeSkill = (skillFile && /^[\w-]+\.md$/.test(skillFile)) ? skillFile
    : (mode !== 'assess' && mode !== 'split' && m[2] === 'pr') ? '_pr.md' : `_${mode}.md`;
  const skillFiles = ['_all.md', modeSkill, '_done.md'];
  const skills = skillFiles
    .map((f) => { try { return readFileSync(join(ROOT, 'skills', f), 'utf8').trim(); } catch { return ''; } })
    .filter(Boolean).join('\n\n');
  const head = `GitHub ${m[2]} #${m[3]} (${m[1]}):\n` +
    `- リポジトリ: ${repo.path}\n- タイトル: ${it.title ?? ''}\n- URL: ${it.url ?? ''}\n` +
    `- 本文:\n${it.body || '(本文なし)'}\n\n## リポジトリ指針\n${policy}\n\n` +
    (skills ? `## 追加スキル指示\n${skills}\n\n` : '');
  return { key, text: mode === 'assess'
    ? head + `この課題の対応可否を【評価のみ】してください（コード変更・コミット禁止）。\n` +
      `最後に <!--devin-assess\\n{"feasible":"yes|needs-human|no","risk":"low|medium|high",` +
      `"category":"auto|review|human|reject","partial":true|false,"reason":"理由","plan":"方針"}` +
      `\\ndevin-assess--> ブロックを出力。\n` +
      `partial は「要求の一部が既に実装済み・分割可能な残作業がある」場合のみ true。`
    : mode === 'split'
    ? head + `この課題について、現在のリポジトリ状態を確認し、実装済みの部分と未実装の部分を切り分けてください（コード変更はしない）。\n` +
      `1. 実装状況を調査（git log / コードの現状 / PR履歴）\n` +
      `2. 元 issue を実装済み扱いにする: gh issue edit ${m[3]} -R ${m[1]} --add-label devin:done し、\n` +
      `   「実装済み部分は完了として切り分け。残りは新規 issue #N に移行」のコメントを投稿\n` +
      `3. 未実装の残り作業をまとめた新規 issue を gh issue create -R ${m[1]} で作成\n` +
      `   （タイトル先頭に [残課題]、本文に元 issue #${m[3]} への参照と残作業の箇条書き）\n` +
      `4. 最後に <!--split\\n{"newKey":"${m[1]} issue#<新issue番号>"}\\nsplit--> ブロックを出力`
    : head + (m[2] === 'pr'
        ? `gh pr checkout ${m[3]} -R ${m[1]} で対象 PR のブランチへ移り、レビュー指摘・CI 失敗等へ対応→検証→push。\n` +
          `新規ブランチ・新規 PR の作成は禁止。main直push・force push禁止。\n`
        : `ブランチ devin/${m[2]}-${m[3]} を切り、実装→検証→push→` +
          `gh pr create（本文に Closes #${m[3]}）。main直push・force push禁止。\n`) +
      `検証が NG の場合は修正→再検証のループを最大 ${config.implLoopMax ?? 5} 回まで行う。\n` +
      `上限に達しても完了しない場合は「対応困難」として理由と現状を ` +
      `${m[2] === 'pr' ? 'PR' : 'issue'} コメントで報告し、ユーザーへ対応を依頼する。\n` +
      `PR を作成した場合は最後に <!--impl-pr\\n{"prKey":"${m[1]} pr#<作成したPR番号>"}\\nimpl-pr--> ` +
      `ブロックを出力（作成した PR は評価スキルで評価されてから PR 対応へ進む）。` };
}

const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > limit) req.destroy(); });
  req.on('end', () => resolve(s));
  req.on('error', reject);
});

function startDispatcher(mode = 'loop') {
  if (child) return { ok: false, error: 'already running' };
  const args = mode === 'once' ? ['dispatcher.mjs', '--once'] : ['dispatcher.mjs'];
  const proc = spawn(process.execPath, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child = { proc, pid: proc.pid, startedAt: new Date().toISOString(), mode };
  proc.on('error', () => { child = null; });
  proc.on('close', () => { child = null; });
  return { ok: true, pid: proc.pid };
}

function stopDispatcher() {
  if (!child) return { ok: false, error: 'not running' };
  child.proc.kill();
  return { ok: true };
}

// ---------- API ----------

function tailLines(path, n) {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(Math.min(size, 256 * 1024));
  readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
  closeSync(fd);
  return buf.toString('utf8').trimEnd().split('\n').slice(-n).join('\n');
}

// チャット評価の判定結果を state.tasks[key].assess に反映する監視
// （チャット内でエージェントが <!--devin-assess-->{JSON} を出力 → パネル判定列へ）
const assessWatchers = new Set();
function watchAssess(key, ch) {
  if (assessWatchers.has(key)) return;
  assessWatchers.add(key);
  const iv = setInterval(() => {
    if (ch.busy) return;
    clearInterval(iv);
    assessWatchers.delete(key);
    // 直近の agent メッセージ群（最大8件）から判定・split ブロックを横断検出
    let verdictDone = false, splitDone = false, scanned = 0;
    for (let i = ch.messages.length - 1; i >= 0 && scanned < 8; i--) {
      const msg = ch.messages[i];
      if (msg.role !== 'agent') continue;
      scanned++;
      if (!verdictDone) {
        const m = msg.text.match(/<!--devin-assess\s*([\s\S]*?)devin-assess-->/);
        if (m) {
          verdictDone = true;
          try {
            const v = JSON.parse(m[1].trim());
            const st = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
            st.tasks[key] = { ...(st.tasks[key] ?? {}),
              assess: v, assessedAt: new Date().toISOString(), engine: 'chat' };
            writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
            // 自動連鎖: issue課題は autoTrigger、pr課題は autoPr が ON のとき
            // 判定・リスクが自動処理範囲内なら対応（impl）へ投入
            const autoOk = key.includes(' pr#')
              ? (config.autoPr ?? false) : (config.autoTrigger ?? false);
            if (autoOk && catAllowed(v.category) && riskAllowed(v.risk) &&
                !['running', 'done', 'needs-review', 'rejected'].includes(st.tasks[key]?.status) &&
                !chatWait.some((w) => w.key === key)) {
              chatWait.push({ key, mode: 'impl' });
            }
          } catch { /* malformed JSON */ }
        }
      }
      if (!splitDone) {
        const sp = msg.text.match(/<!--split\s*([\s\S]*?)split-->/);
        if (sp) {
          splitDone = true;
          try {
            const { newKey } = JSON.parse(sp[1].trim());
            if (newKey) {
              const st2 = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
              st2.tasks[key] = { ...(st2.tasks[key] ?? {}),
                splitTo: newKey, splitAt: new Date().toISOString() };
              writeFileSync(STATE_PATH, JSON.stringify(st2, null, 2));
              const p = taskPrompt(newKey, 'assess');
              if (p && !p.error) {
                ch.send(p.text).then(() => watchAssess(newKey, ch));
              }
            }
          } catch { /* noop */ }
        }
      }
      if (verdictDone && splitDone) break;
    }
  }, 3000);
  // 30分で強制終了
  setTimeout(() => { clearInterval(iv); assessWatchers.delete(key); }, 30 * 60 * 1000).unref?.();
}

// 切り分け完了を監視: <!--split {"newKey":...}--> を検出したら新 issue を自動再評価
function watchSplit(key, ch) {
  const iv = setInterval(() => {
    if (ch.busy) return;
    clearInterval(iv);
    for (let i = ch.messages.length - 1; i >= 0; i--) {
      const msg = ch.messages[i];
      if (msg.role !== 'agent') continue;
      const m = msg.text.match(/<!--split\s*([\s\S]*?)split-->/);
      if (!m) continue;
      try {
        const { newKey } = JSON.parse(m[1].trim());
        if (newKey) {
          const st = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
          st.tasks[key] = { ...(st.tasks[key] ?? {}),
            splitTo: newKey, splitAt: new Date().toISOString() };
          writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
          const p = taskPrompt(newKey, 'assess');
          if (p && !p.error) {
            ch.send(p.text).then(() => watchAssess(newKey, ch));
          }
        }
      } catch { /* noop */ }
      break;
    }
  }, 3000);
  setTimeout(() => clearInterval(iv), 30 * 60 * 1000).unref?.();
}

// 対応完了を監視: <!--impl-pr {"prKey":...}--> または PR URL を検出したら作成 PR を評価キューへ投入
const implWatchers = new Set();
function watchImpl(key, ch) {
  if (implWatchers.has(key)) return;
  implWatchers.add(key);
  const repo = key.slice(0, key.indexOf(' '));
  const iv = setInterval(() => {
    if (ch.busy) return;
    clearInterval(iv);
    implWatchers.delete(key);
    // 直近30件の agent メッセージから検出: まずマーカー（正規経路）、無ければ PR URL で補完
    let prKey = null;
    const agentMsgs = [];
    for (let i = ch.messages.length - 1; i >= 0 && agentMsgs.length < 30; i--) {
      if (ch.messages[i].role === 'agent') agentMsgs.push(ch.messages[i].text);
    }
    for (const text of agentMsgs) {
      const m = text.match(/<!--impl-pr\s*([\s\S]*?)impl-pr-->/);
      if (m) { try { prKey = JSON.parse(m[1].trim()).prKey || null; } catch { /* noop */ } break; }
    }
    if (!prKey) {
      for (const text of agentMsgs) {
        const u = text.match(/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/);
        if (u) { prKey = repo + ' pr#' + u[1]; break; }
      }
    }
    if (!prKey) return;
    const st = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
    st.tasks[key] = { ...(st.tasks[key] ?? {}),
      createdPr: prKey, prAt: new Date().toISOString() };
    writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
    if (!chatWait.some((w) => w.key === prKey) &&
        ![...chats.values()].some((s) => s.chat.busy && s.label === prKey + ' assess') &&
        !st.tasks[prKey]?.assess?.category) {
      chatWait.push({ key: prKey, mode: 'assess' });
    }
  }, 3000);
  setTimeout(() => { clearInterval(iv); implWatchers.delete(key); }, 30 * 60 * 1000).unref?.();
}

function status() {
  const state = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
  const tasks = Object.entries(state.tasks ?? {})
    .map(([key, t]) => ({ key, ...t }))
    .sort((a, b) => (b.startedAt ?? b.finishedAt ?? '').localeCompare(a.startedAt ?? a.finishedAt ?? ''))
    .slice(0, 30);
  return {
    running: !!child,
    pid: child?.pid ?? null,
    mode: child?.mode ?? null,
    startedAt: child?.startedAt ?? null,
    desired: loadDesired(),
    deployedAt: state.deployedAt,
    manualRuns: [...manualRuns.keys()],
    config: {
      pollIntervalSec: config.pollIntervalSec ?? 120,
      candidateCacheSec: config.candidateCacheSec ?? config.pollIntervalSec ?? 120,
      autoDiscover: config.autoDiscover ?? true,
      autoTrigger: config.autoTrigger ?? false,
      autoAssess: config.autoAssess ?? false,
      autoPr: config.autoPr ?? false,
      autoCategory: config.autoCategory ?? 'review',
      maxAutoRisk: config.maxAutoRisk ?? 'medium',
      engine: config.engine ?? 'devin',
      bridgeHub: config.bridgeHub ?? 'http://127.0.0.1:8511',
      apiUrl: config.apiUrl ?? '', apiModel: config.apiModel ?? '',
      apiModels: config.apiModels ?? {},
      bridgeModels: config.bridgeModels ?? {},
      apiKeySet: !!effectiveApiKey(), // 値自体は返さない（hasValue のみ）
      extraPrompt: config.extraPrompt ?? '',
      repos: (config.repos || []).map((r) => r.github),
      assessMaxAgeHours: config.assessMaxAgeHours ?? 24,
      autoTriggerSince: config.autoTriggerSince ?? null,
      permissionMode: config.permissionMode ?? 'dangerous',
      maxConcurrent: config.maxConcurrent ?? 1,
      maxConcurrentAssess: config.maxConcurrentAssess ?? config.maxConcurrent ?? 1,
      maxConcurrentImpl: config.maxConcurrentImpl ?? config.maxConcurrent ?? 1,
      implLoopMax: config.implLoopMax ?? 5,
      maxConcurrentPr: config.maxConcurrentPr ?? config.maxConcurrentImpl ?? config.maxConcurrent ?? 1,
      maxNewPerPoll: config.maxNewPerPoll ?? 50,
      repos: (config.repos ?? []).map((r) => r.github),
    },
    tasks,
    // チャット実行中の課題（key 起点のラベル）— パネルの「評価中/対応中」表示用
    chatBusy: sessionsList().filter((s) => s.busy).map((s) => s.label),
    chatWaiting: chatWait.map((w) => w.key + ' ' + w.mode),
  };
}

function candLabels() {
  return {
    trigger: config.triggerLabel ?? 'devin',
    running: config.runningLabel ?? 'devin:running',
    done: config.doneLabel ?? 'devin:done',
    failed: config.failedLabel ?? 'devin:failed',
    needsReview: config.needsReviewLabel ?? 'devin:needs-review',
    rejected: config.rejectedLabel ?? 'devin:rejected',
  };
}

function writeCandsCache(items) {
  const fetchedAt = new Date().toISOString();
  const tmp = CANDS_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify({ fetchedAt, candidates: items }, null, 2));
  renameSync(tmp, CANDS_PATH);
  return fetchedAt;
}

async function candidates(force) {
  const labels = candLabels();
  const cacheMs = (config.candidateCacheSec ?? config.pollIntervalSec ?? 120) * 1000;
  const cache = loadJson(CANDS_PATH, null);
  const fresh = cache && Date.now() - new Date(cache.fetchedAt).getTime() < cacheMs;

  let raw, fetchedAt, cached;
  if (!force && fresh) {
    ({ candidates: raw, fetchedAt } = cache);
    cached = true;
  } else {
    const st0 = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
    // 検出は常に実行（autoTrigger は起動制御であり候補検出の条件ではない）
    const found = await discover({
      config, labels, state: st0,
      autoTrigger: true,
      maxNewPerPoll: config.maxNewPerPoll ?? 50,
      storePath: ISSUES_PATH,
    });
    raw = found.map((t) => toCandidate(t, labels));
    fetchedAt = writeCandsCache(raw);
    cached = false;
  }

  // state は常に最新で付与（キャッシュは課題の「存在」のみ保存）
  const state = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
  const issuesAll = readIssueStore(ISSUES_PATH).issues ?? {};
  // 全 open 課題数（issues.json ストア由来。repo 別の総件数表示用）
  const openCounts = {};
  for (const [key, v] of Object.entries(issuesAll)) {
    openCounts[v.repo] = (openCounts[v.repo] ?? 0) + 1;
  }
  return {
    fetchedAt, cached,
    autoEnabled: config.autoTrigger ?? false,
    discoverEnabled: config.autoDiscover ?? true,
    openCounts,
    candidates: raw.map((c) => {
      const key = keyOf(c.repo, c.type, c.number);
      const t = state.tasks?.[key];
      return { key, ...c, state: t?.status ?? null, assess: t?.assess ?? null,
        createdPr: t?.createdPr ?? null,
        engineReq: t?.engineReq ?? null,
        engineIssue: issueEngine(key, issuesAll),
        engine: resolveEngine(key, null, null, state.tasks, issuesAll),
        engineUsed: t?.engineUsed ?? null };
    }),
  };
}

// ---- MCP (Streamable HTTP): 管理系ツールを外部 MCP クライアントへ公開 ----
// /mcp は X-Panel を課さない（MCP クライアントはカスタムヘッダを送れない）。
// Content-Type: application/json の POST はブラウザでは preflight 必須のため、
// 未許可オリジンは CORS で既に遮断される。127.0.0.1 バインドで外部直叩き不可。
// tools/call は自前の /api/* へ内部プロキシし、権限・検証ロジックを単一実装に保つ。
// queue_*（pull 型の課題引受ツール）は IDE エージェント専用の stdio 版
// (mcp-server.mjs) に限定し、ここでは管理系のみ公開する。
const MCP_PROTOCOL = '2025-06-18';
const MCP_SERVER_INFO = { name: 'devin-agent-dispatcher', version: '1.0.0' };
const RO = { readOnlyHint: true };
const WR = { readOnlyHint: false };
const DE = { readOnlyHint: false, destructiveHint: true };
const KEY_PARAM = { type: 'string', description: "課題キー 'owner/repo issue#N' または 'owner/repo pr#N'" };
const MCP_TOOLS = [
  { name: 'status', annotations: RO,
    description: '稼働状態・設定・最近タスク・実行中セッションを取得',
    inputSchema: { type: 'object', properties: {} },
    api: { method: 'GET', path: '/api/status' } },
  { name: 'candidates', annotations: RO,
    description: '監視対象リポジトリの対応候補課題（open issue/PR・評価結果・状態）一覧',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean', description: 'キャッシュを無視して再取得' } } },
    api: { method: 'GET', path: (a) => '/api/candidates' + (a.force ? '?force=1' : '') } },
  { name: 'log', annotations: RO,
    description: 'dispatcher ログ末尾を取得',
    inputSchema: { type: 'object', properties: { n: { type: 'number', description: '行数(既定200)' } } },
    api: { method: 'GET', path: (a) => `/api/log?n=${encodeURIComponent(a.n ?? 200)}` } },
  { name: 'task_log', annotations: RO,
    description: '課題セッションのログ末尾を取得',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM, n: { type: 'number' } }, required: ['key'] },
    api: { method: 'GET', path: (a) => `/api/tasklog?key=${encodeURIComponent(a.key ?? '')}&n=${encodeURIComponent(a.n ?? 150)}` } },
  { name: 'chat_sessions', annotations: RO,
    description: '内蔵チャット（エンジン実行セッション）の一覧',
    inputSchema: { type: 'object', properties: {} },
    api: { method: 'GET', path: '/api/chat/sessions' } },
  { name: 'chat_get', annotations: RO,
    description: 'チャットセッションのメッセージ履歴（id 省略で最新）',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } } },
    api: { method: 'GET', path: (a) => `/api/chat?id=${encodeURIComponent(a.id ?? 0)}` } },
  { name: 'goals_list', annotations: RO,
    description: '課題整理タブの目的（goals）一覧',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
    api: { method: 'GET', path: (a) => '/api/goals' + (a.repo ? `?repo=${encodeURIComponent(a.repo)}` : '') } },
  { name: 'skills_list', annotations: RO,
    description: 'skills/ の *.md 一覧（モード別・完了時カスタム指示）',
    inputSchema: { type: 'object', properties: {} },
    api: { method: 'GET', path: '/api/skills' } },
  { name: 'auth_status', annotations: RO,
    description: 'devin CLI のログイン状態を確認',
    inputSchema: { type: 'object', properties: {} },
    api: { method: 'GET', path: '/api/auth' } },
  { name: 'dispatch', annotations: WR,
    description: '課題を作業キューへ登録（実装）。IDE エージェントが MCP(issue-queue) 経由で取り出して実行',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM, engine: { type: 'string', description: 'devin/copilot/antigravity/api' } }, required: ['key'] },
    api: { method: 'POST', path: '/api/dispatch' } },
  { name: 'assess', annotations: WR,
    description: '課題を評価キューへ登録（評価のみ・実装しない）',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM, engine: { type: 'string' } }, required: ['key'] },
    api: { method: 'POST', path: '/api/assess' } },
  { name: 'chat_task', annotations: WR,
    description: '課題をエンジンセッションで即時実行（assess=評価/impl=実装/split=切り分け）',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM, mode: { type: 'string', description: 'assess/impl/split' }, skill: { type: 'string' }, engine: { type: 'string' } }, required: ['key'] },
    api: { method: 'POST', path: '/api/chat/task' } },
  { name: 'chat_send', annotations: WR,
    description: '内蔵チャットへ自由文を送信（id 省略で空き/新規セッション）',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, id: { type: 'number' } }, required: ['text'] },
    api: { method: 'POST', path: '/api/chat/send' } },
  { name: 'steer', annotations: WR,
    description: '実行中課題セッションへ追加入力（ACP ランナー経由のみ有効）',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM, text: { type: 'string' } }, required: ['key', 'text'] },
    api: { method: 'POST', path: '/api/steer' } },
  { name: 'issue_create', annotations: WR,
    description: '監視対象リポジトリへ GitHub Issue を起票',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['repo', 'title'] },
    api: { method: 'POST', path: '/api/issue' } },
  { name: 'verdict', annotations: WR,
    description: '課題の評価カテゴリを手動上書き（auto/review/human/reject）',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM, category: { type: 'string' } }, required: ['key', 'category'] },
    api: { method: 'POST', path: '/api/verdict' } },
  { name: 'task_engine', annotations: WR,
    description: '課題単位の実行エンジン指定（空 engine で解除）',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM, engine: { type: 'string' } }, required: ['key'] },
    api: { method: 'POST', path: '/api/task-engine' } },
  { name: 'config_update', annotations: WR,
    description: 'config.json の許可キーを更新（patch オブジェクトをそのまま適用）',
    inputSchema: { type: 'object', properties: { patch: { type: 'object' } }, required: ['patch'] },
    api: { method: 'POST', path: '/api/config', body: (a) => a.patch ?? {} } },
  { name: 'assess_all', annotations: WR,
    description: '全候補のうち未評価のものを評価キューへ一括投入',
    inputSchema: { type: 'object', properties: {} },
    api: { method: 'POST', path: '/api/assess-all', body: () => ({}) } },
  { name: 'impl_all', annotations: WR,
    description: '自動処理条件を満たす全課題を対応キューへ一括投入',
    inputSchema: { type: 'object', properties: {} },
    api: { method: 'POST', path: '/api/impl-all', body: () => ({}) } },
  { name: 'start', annotations: WR,
    description: 'dispatcher ポーリングループを起動',
    inputSchema: { type: 'object', properties: {} },
    api: { method: 'POST', path: '/api/start', body: () => ({}) } },
  { name: 'kill', annotations: DE,
    description: '実行中課題セッションを停止',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM }, required: ['key'] },
    api: { method: 'POST', path: '/api/kill' } },
  { name: 'chat_cancel', annotations: DE,
    description: '実行中チャットセッションをキャンセル',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    api: { method: 'POST', path: '/api/chat/cancel' } },
  { name: 'chat_close', annotations: DE,
    description: 'チャットセッションを閉じる',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    api: { method: 'POST', path: '/api/chat/close' } },
  { name: 'issue_close', annotations: DE,
    description: 'GitHub Issue をクローズ（issue 課題のみ）',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM }, required: ['key'] },
    api: { method: 'POST', path: '/api/close' } },
  { name: 'stop', annotations: DE,
    description: 'dispatcher ポーリングループを停止',
    inputSchema: { type: 'object', properties: {} },
    api: { method: 'POST', path: '/api/stop', body: () => ({}) } },
];

async function mcpToolCall(tool, args) {
  const path = typeof tool.api.path === 'function' ? tool.api.path(args) : tool.api.path;
  let res;
  if (tool.api.method === 'GET') {
    res = await fetch(SELF_ORIGIN + path);
  } else {
    const body = typeof tool.api.body === 'function' ? tool.api.body(args) : args;
    res = await fetch(SELF_ORIGIN + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel': '1' },
      body: JSON.stringify(body ?? {}),
    });
  }
  return await res.json().catch(() => ({}));
}

async function handleMcp(req, res, acao) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (acao) headers['Access-Control-Allow-Origin'] = acao;
  let msg;
  try { msg = JSON.parse(await readBody(req) || '{}'); }
  catch { msg = null; }
  const reply = (code, obj, extra) => {
    res.writeHead(code, { ...headers, ...(extra ?? {}) });
    res.end(JSON.stringify(obj));
  };
  if (!msg || typeof msg !== 'object') {
    return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  if (msg.id == null) {
    res.writeHead(202, headers);
    return res.end();
  }
  const id = msg.id;
  const result = (r) => reply(200, { jsonrpc: '2.0', id, result: r });
  const error = (code, message) => reply(200, { jsonrpc: '2.0', id, error: { code, message } });
  const method = String(msg.method ?? '');
  if (method === 'initialize') {
    return reply(200, {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
      },
    }, { 'Mcp-Session-Id': crypto.randomUUID() });
  }
  if (method === 'ping') return result({});
  if (method === 'tools/list') {
    return result({
      tools: MCP_TOOLS.map((t) => ({
        name: t.name, description: t.description,
        inputSchema: t.inputSchema, annotations: t.annotations,
      })),
    });
  }
  if (method === 'tools/call') {
    const name = msg.params?.name;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    const text = (obj, isError) => result({
      content: [{ type: 'text', text: JSON.stringify(obj) }],
      ...(isError ? { isError: true } : {}),
    });
    if (!tool) return text({ error: `unknown tool: ${name}` }, true);
    try {
      const out = await mcpToolCall(tool, msg.params?.arguments ?? {});
      return text(out, out?.ok === false);
    } catch (e) {
      return text({ error: String(e?.message ?? e) }, true);
    }
  }
  return error(-32601, `method not found: ${method}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const acao = corsOrigin(req);
  const baseHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
  if (acao) baseHeaders['Access-Control-Allow-Origin'] = acao;
  const json = (code, obj) => {
    res.writeHead(code, baseHeaders);
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'OPTIONS') {
    if (!acao) return json(403, { ok: false });
    res.writeHead(204, {
      'Access-Control-Allow-Origin': acao,
      // X-Panel: パネル CSRF 対策 / Content-Type・MCP 系: /mcp の Streamable HTTP
      'Access-Control-Allow-Headers': 'X-Panel, Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Max-Age': '600',
      // public→private 通信（CDN ホスト版から localhost API 利用）に必要
      'Access-Control-Allow-Private-Network': 'true',
    });
    return res.end();
  }

  if (req.method === 'POST') {
    if (url.pathname === '/mcp') return await handleMcp(req, res, acao);
    // CSRF: カスタムヘッダ必須。preflight は行わないので外部サイトからは送信不可
    if (req.headers[PANEL_HEADER[0]] !== PANEL_HEADER[1]) {
      return json(403, { ok: false, error: 'missing X-Panel header' });
    }
    try {
      if (url.pathname === '/api/start') {
        saveDesired({ enabled: true });
        return json(200, startDispatcher('loop'));
      }
      if (url.pathname === '/api/stop') {
        saveDesired({ enabled: false });
        return json(200, stopDispatcher());
      }
      if (url.pathname === '/api/assess-all') {
        // 全候補のうち判定未出力のものを評価キューへ（上限は待機キューで調整）
        const cands = loadJson(join(ROOT, 'candidates.json'), { candidates: [] }).candidates ?? [];
        const st = loadJson(STATE_PATH, { tasks: {} }).tasks ?? {};
        let n = 0;
        for (const c of cands) {
          const key = c.key ?? `${c.repo} ${c.type}#${c.number}`;
          if (!st[key]?.assess?.category && !chatWait.some((w) => w.key === key)) {
            chatWait.push({ key, mode: 'assess' });
            n++;
          }
        }
        return json(200, { ok: true, queued: n });
      }
      if (url.pathname === '/api/impl-all') {
        // 自動処理設定（autoCategory × maxAutoRisk の AND）に適合する全課題を対応キューへ
        const cands = loadJson(join(ROOT, 'candidates.json'), { candidates: [] }).candidates ?? [];
        const st = loadJson(STATE_PATH, { tasks: {} }).tasks ?? {};
        let n = 0;
        for (const c of cands) {
          const key = c.key ?? `${c.repo} ${c.type}#${c.number}`;
          const a = st[key]?.assess;
          if (!a?.category || a.error) continue;
          if (!catAllowed(a.category) || !riskAllowed(a.risk)) continue;
          const s = st[key]?.status;
          if (s === 'running' || s === 'done' || s === 'needs-review' || s === 'rejected') continue;
          if (chatWait.some((w) => w.key === key)) continue;
          chatWait.push({ key, mode: 'impl' });
          n++;
        }
        return json(200, { ok: true, queued: n });
      }
      if (url.pathname === '/api/once') {
        return json(200, startDispatcher('once'));
      }
      if (url.pathname === '/api/reload') {
        config = loadJson(CONFIG_PATH, config);
        secrets = loadJson(SECRETS_PATH, secrets);
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/config') {
        // config.json の一部キーを更新（ファイル + メモリ両方）
        const allowed = ['pollIntervalSec', 'candidateCacheSec', 'maxNewPerPoll',
          'maxConcurrent', 'maxConcurrentAssess', 'maxConcurrentImpl', 'maxConcurrentPr',
          'autoDiscover', 'autoTrigger', 'autoAssess', 'autoPr', 'autoCategory',
          'maxAutoRisk',
          'assessMaxAgeHours', 'autoTriggerSince', 'permissionMode', 'implLoopMax',
          'engine', 'bridgeHub', 'apiUrl', 'apiModel', 'extraPrompt',
          'apiModels', 'bridgeModels', 'acpOptions'];
        const patch = JSON.parse((await readBody(req)) || '{}');
        const fresh = loadJson(CONFIG_PATH, config);
        const applied = {};
        // シークレット類は secrets.json（Git 管理外）へ保存。config.json には書かない
        if (patch.apiKey !== undefined) {
          const sec = loadJson(SECRETS_PATH, {});
          if (patch.apiKey) sec.apiKey = String(patch.apiKey); else delete sec.apiKey;
          writeFileSync(SECRETS_PATH, JSON.stringify(sec, null, 2) + '\n');
          secrets = sec;
          applied.apiKey = patch.apiKey ? 'saved to secrets.json' : 'cleared';
        }
        // config.json に残存する apiKey（旧形式・手動編集分）も secrets へ移して除去
        if (fresh.apiKey) {
          const sec = loadJson(SECRETS_PATH, secrets);
          if (!sec.apiKey) sec.apiKey = fresh.apiKey;
          delete fresh.apiKey;
          writeFileSync(SECRETS_PATH, JSON.stringify(sec, null, 2) + '\n');
          secrets = sec;
        }
        for (const k of allowed) {
          if (patch[k] !== undefined) { fresh[k] = patch[k]; applied[k] = patch[k]; }
        }
        if (!Object.keys(applied).length) {
          return json(400, { ok: false, error: 'no allowed keys in patch' });
        }
        writeFileSync(CONFIG_PATH, JSON.stringify(fresh, null, 2) + '\n');
        config = fresh;
        // autoPr を ON にした時点で、auto 判定済み・未完了の pr# 課題を対応キューへ投入
        if (applied.autoPr === true) {
          const st = loadJson(STATE_PATH, { tasks: {} });
          for (const [k, t] of Object.entries(st.tasks || {})) {
            if (k.includes(' pr#') && catAllowed(t?.assess?.category) &&
                riskAllowed(t?.assess?.risk) &&
                t?.status !== 'done' && t?.status !== 'running' &&
                !chatWait.some((w) => w.key === k)) {
              chatWait.push({ key: k, mode: 'impl' });
            }
          }
        }
        return json(200, { ok: true, applied });
      }
      if (url.pathname === '/api/skill') {
        // skills/<name> を保存（ファイル名は *.md のみ・パス走査防止）
        const { name, content } = JSON.parse((await readBody(req)) || '{}');
        if (!/^[\w-]+\.md$/.test(name ?? '')) return json(400, { ok: false, error: 'bad name' });
        mkdirSync(join(ROOT, 'skills'), { recursive: true });
        writeFileSync(join(ROOT, 'skills', name), String(content ?? ''));
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/chat/send') {
        const { id, text } = JSON.parse((await readBody(req)) || '{}');
        if (!text) return json(400, { ok: false, error: 'empty text' });
        const sid = id && chats.has(id) ? id : pickChatId('chat');
        try { await chats.get(sid).chat.send(String(text)); return json(200, { ok: true, id: sid }); }
        catch (e) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/chat/option') {
        const { sid, id, value } = JSON.parse((await readBody(req)) || '{}');
        try {
          await chats.get(sid).chat.setOption(id, value);
          // モデル/モード選択を config.acpOptions へ永続化（次回 session/new で再適用）
          const fresh = loadJson(CONFIG_PATH, config);
          (fresh.acpOptions ??= {})[id] = value;
          writeFileSync(CONFIG_PATH, JSON.stringify(fresh, null, 2) + '\n');
          config = fresh;
          return json(200, { ok: true });
        }
        catch (e) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/chat/clear') {
        const { id } = JSON.parse((await readBody(req)) || '{}');
        chats.get(id)?.chat.clear();
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/chat/cancel') {
        const { id } = JSON.parse((await readBody(req)) || '{}');
        await chats.get(id)?.chat.cancel();
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/chat/reset') {
        const { id } = JSON.parse((await readBody(req)) || '{}');
        await chats.get(id)?.chat.reset();
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/chat/close') {
        const { id } = JSON.parse((await readBody(req)) || '{}');
        const s = chats.get(id);
        if (s) { try { await s.chat.reset(); } catch { /* noop */ } chats.delete(id); }
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/close') {
        // issue をクローズ（gh issue close + state 記録）
        const { key } = JSON.parse((await readBody(req)) || '{}');
        const m = String(key ?? '').match(/^(\S+)\s+(issue|pr)#(\d+)$/);
        if (!m || m[2] !== 'issue') return json(400, { ok: false, error: 'bad key: ' + key });
        try {
          await new Promise((res, rej) => {
            execFile('gh', ['issue', 'close', m[3], '-R', m[1],
              '--comment', 'Devin dispatcher からクローズ'],
              (e, so, se) => e ? rej(new Error(se || e.message)) : res(so));
          });
          const st = loadJson(STATE_PATH, { tasks: {} });
          st.tasks[key] = { ...(st.tasks[key] ?? {}), status: 'closed',
            closedAt: new Date().toISOString() };
          writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
          return json(200, { ok: true });
        } catch (e) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/models') {
        // モデル一覧取得。provider=api → OpenAI互換 GET {apiUrl}/models
        // provider=copilot/antigravity → bridge-hub GET /models?provider=
        const { provider } = JSON.parse((await readBody(req)) || '{}');
        if (provider === 'copilot' || provider === 'antigravity') {
          const hub = (config.bridgeHub || 'http://127.0.0.1:8511').replace(/\/+$/, '');
          const r = await fetch(`${hub}/models?provider=${provider}`);
          const j = await r.json().catch(() => null);
          if (!r.ok || !j?.models) {
            return json(502, { ok: false, error: j?.error || 'hub models ' + r.status });
          }
          // fallback:true は CLI 未ログイン疑い（固定一覧）としてパネルへ伝達
          return json(200, { ok: true,
            models: j.models.map((m) => m.id ?? m).filter(Boolean),
            fallback: !!j.fallback });
        }
        const u = (config.apiUrl || '').replace(/\/+$/, '');
        if (!u) return json(400, { ok: false, error: 'apiUrl 未設定' });
        const r = await fetch(u + '/models',
          { headers: effectiveApiKey() ? { Authorization: 'Bearer ' + effectiveApiKey() } : {} });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j?.data) return json(502, { ok: false, error: 'models ' + r.status });
        return json(200, { ok: true, models: j.data.map((m) => m.id).filter(Boolean) });
      }
      if (url.pathname === '/api/bridge-install') {
        // bridge-hub.exe を CDN から取得して自己インストール（8511 常駐）を起動
        const url0 = 'https://yamamoto-ryuzo.github.io/kasugai-canvas-web/stable/download/bridge-hub.exe';
        const dst = join(ROOT, 'bridge-hub.exe');
        const r = await fetch(url0);
        if (!r.ok) return json(500, { ok: false, error: 'download ' + r.status });
        writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
        spawn(dst, [], { detached: true, stdio: 'ignore' }).unref();
        return json(200, { ok: true, path: dst });
      }
      if (url.pathname === '/api/verdict') {
        // パネルから判定を手動上書き（相反するが価値ある課題のユーザー判断の委ね先）
        const { key, category } = JSON.parse((await readBody(req)) || '{}');
        if (!['auto', 'review', 'human', 'reject'].includes(category)) {
          return json(400, { ok: false, error: 'bad category: ' + category });
        }
        const st = loadJson(STATE_PATH, { tasks: {} });
        if (!st.tasks[key]?.assess) return json(404, { ok: false, error: 'no assess: ' + key });
        st.tasks[key].assess = { ...st.tasks[key].assess, category, manualCategory: true };
        writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/goals') {
        // 課題整理タブの目的（やりたいこと）をリポジトリ単位で保存
        const { id, repo, text, images } = JSON.parse((await readBody(req, 25 * 1024 * 1024)) || '{}');
        if (!repo || !text?.trim()) return json(400, { ok: false, error: 'repo/text required' });
        const g = loadJson(GOALS_PATH, []);
        const gid = id || 'g' + Date.now();
        const rec = { id: gid, repo, text, images: Array.isArray(images) ? images : [] };
        const i = g.findIndex((x) => x.id === gid);
        if (i >= 0) g[i] = rec; else g.push(rec);
        writeFileSync(GOALS_PATH, JSON.stringify(g, null, 2));
        return json(200, { ok: true, id: gid });
      }
      if (url.pathname === '/api/goal/delete') {
        const { id } = JSON.parse((await readBody(req)) || '{}');
        const g = loadJson(GOALS_PATH, []).filter((x) => x.id !== id);
        writeFileSync(GOALS_PATH, JSON.stringify(g, null, 2));
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/shot') {
        // 課題整理タブの貼り付け画像を shots/ へ保存（抽出プロンプトへパスを添付する用）
        const { data } = JSON.parse((await readBody(req, 25 * 1024 * 1024)) || '{}');
        const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(data || '');
        if (!m) return json(400, { ok: false, error: 'bad image data' });
        const dir = join(ROOT, 'shots');
        mkdirSync(dir, { recursive: true });
        const fp = join(dir, 'shot_' + Date.now() + '_' +
          Math.random().toString(36).slice(2, 7) +
          '.' + (m[1].toLowerCase().startsWith('jp') ? 'jpg' : m[1].toLowerCase()));
        writeFileSync(fp, Buffer.from(m[2], 'base64'));
        return json(200, { ok: true, path: fp });
      }
      if (url.pathname === '/api/issue') {
        // 課題整理タブからの Issue 起票（監視リポジトリ限定）
        const { repo, title, body } = JSON.parse((await readBody(req)) || '{}');
        if (!config.repos?.some((r) => r.github === repo)) {
          return json(400, { ok: false, error: 'repo not monitored: ' + repo });
        }
        if (!title) return json(400, { ok: false, error: 'empty title' });
        try {
          const out = await new Promise((res2, rej) => {
            execFile('gh', ['issue', 'create', '-R', repo,
              '--title', title, '--body', String(body ?? '')],
              (e, so, se) => e ? rej(new Error(se || e.message)) : res2(so));
          });
          return json(200, { ok: true, url: String(out).trim() });
        } catch (e) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/chat/task') {
        // パネルの「評価」「対応」ボタン → 空き/新規セッションへ自動送信
        // engine 指定時はそのエンジンで実行（未指定は課題指定→config.engine の順に解決）
        const { key, mode, skill, engine } = JSON.parse((await readBody(req)) || '{}');
        const p = taskPrompt(key, mode, skill);
        if (!p) return json(400, { ok: false, error: 'bad key: ' + key });
        if (p.error) return json(400, { ok: false, error: p.error });
        if (mode !== 'assess' && resolveEngine(key, mode, engine) === 'api') {
          return json(400, { ok: false,
            error: 'api エンジンは評価(assess)専用です。' + mode + ' は起動できません' });
        }
        try {
          if (!chatCapacity(mode, key)) {
            chatWait.push({ key, mode, skill, engine });
            return json(202, { ok: true, queued: true });
          }
          const id = await dispatchChatTask(key, mode, skill, engine);
          return json(200, { ok: true, id });
        }
        catch (e) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/task-engine') {
        // 課題単位のエンジン指定（engineReq）を設定/解除。空欄で解除=全体設定に従う
        const { key, engine } = JSON.parse((await readBody(req)) || '{}');
        if (!/^(\S+)\s+(issue|pr)#(\d+)$/.test(String(key ?? ''))) {
          return json(400, { ok: false, error: 'bad key: ' + key });
        }
        const e = engine == null || engine === '' ? null : normEngine(engine);
        if (engine != null && engine !== '' && !e) {
          return json(400, { ok: false, error: 'unknown engine: ' + engine });
        }
        const st = loadJson(STATE_PATH, { tasks: {} });
        st.tasks[key] = { ...(st.tasks[key] ?? {}) };
        if (e) st.tasks[key].engineReq = e; else delete st.tasks[key].engineReq;
        writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
        return json(200, { ok: true, engineReq: e, resolved: resolveEngine(key, null, null) });
      }
      if (url.pathname === '/api/dispatch' || url.pathname === '/api/assess') {
        // 実行キュー登録: 実実行は Devin IDE のチャットエージェントが
        // MCP (issue-queue) 経由で queue_claim → 実行 → queue_done する
        const isAssess = url.pathname === '/api/assess';
        const { key, engine } = JSON.parse((await readBody(req)) || '{}');
        const m = String(key ?? '').match(/^(\S+)\s+(issue|pr)#(\d+)$/);
        if (!m) return json(400, { ok: false, error: 'bad key: ' + key });
        const repo = config.repos?.find((r) => r.github === m[1]);
        if (!repo) return json(400, { ok: false, error: 'repo not monitored: ' + m[1] });
        const eng = engine == null ? null : normEngine(engine);
        if (engine != null && !eng) {
          return json(400, { ok: false, error: 'unknown engine: ' + engine });
        }
        if (eng === 'api' && !isAssess) {
          return json(400, { ok: false,
            error: 'api エンジンは評価(assess)専用です。impl は起動できません' });
        }
        const q = loadJson(join(ROOT, 'work-queue.json'), { items: [] });
        if (q.items.some((i) => i.key === key && i.mode === (isAssess ? 'assess' : 'impl'))) {
          return json(409, { ok: false, error: 'already queued: ' + key });
        }
        const it = readIssueStore(ISSUES_PATH).issues?.[key] ?? {};
        q.items.push({
          key, mode: isAssess ? 'assess' : 'impl',
          repo, type: m[2], number: +m[3],
          title: it.title ?? '', url: it.url ?? '', body: it.body ?? '',
          ...(eng ? { engine: eng } : {}),
          status: 'pending', queuedAt: new Date().toISOString(),
        });
        writeFileSync(join(ROOT, 'work-queue.json'), JSON.stringify(q, null, 2));
        return json(200, { ok: true, queued: key });
      }
      if (url.pathname === '/api/login') {
        // explorer.exe 経由で .bat を開く → ユーザーの対話セッションに
        // コンソールウィンドウが出る（ログインフローは対話キー入力が必要）
        const bat = join(ROOT, 'login.bat');
        writeFileSync(bat,
          `@echo off\r\ntitle devin auth login\r\n` +
          `"${config.devinExe}" auth logout\r\n` +
          `"${config.devinExe}" auth login\r\npause\r\n`);
        spawn('explorer.exe', [bat],
          { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/kill') {
        // 実行中セッションの停止要求: kill-requests.json に追記（dispatcher が監視して kill）
        const { key } = JSON.parse((await readBody(req)) || '{}');
        if (!key || typeof key !== 'string') return json(400, { ok: false, error: 'bad key' });
        const p = join(ROOT, 'kill-requests.json');
        const cur = loadJson(p, { keys: [] });
        const raw = key.startsWith('assess:') ? key.slice(7) : key;
        if (!cur.keys.includes(raw)) cur.keys.push(raw);
        writeFileSync(p, JSON.stringify(cur));
        return json(200, { ok: true, key: raw });
      }
      if (url.pathname === '/api/steer') {
        // 実行中セッションへの追加入力: steer-requests.json に追記
        // （ACP ランナー経由のセッションのみ有効。-p モードには効かない）
        const { key, text } = JSON.parse((await readBody(req)) || '{}');
        if (!key || !text) return json(400, { ok: false, error: 'need key and text' });
        const p = join(ROOT, 'steer-requests.json');
        const cur = loadJson(p, { items: [] });
        cur.items.push({ key, text: String(text), at: new Date().toISOString() });
        writeFileSync(p, JSON.stringify(cur));
        return json(200, { ok: true });
      }
      // （/api/dispatch・/api/assess は上のキュー登録ブロックに統合）
    } catch (e) {
      return json(500, { ok: false, error: e.message });
    }
    return json(404, { ok: false, error: 'not found' });
  }

  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(PANEL_PATH));
    }
    if (url.pathname === '/docs' || url.pathname === '/docs/' ||
        url.pathname.startsWith('/docs/')) {
      const name = url.pathname === '/docs' || url.pathname === '/docs/'
        ? 'index.html' : url.pathname.slice('/docs/'.length);
      if (!/^[\w-]+\.html$/.test(name)) return json(403, { ok: false });
      try {
        const html = readFileSync(join(ROOT, 'docs', name));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch { return json(404, { ok: false, error: 'docs not found' }); }
    }
    if (url.pathname === '/api/status') return json(200, status());
    if (url.pathname === '/api/auth') {
      // devin.exe のログイン状態（auth status を実行して確認）
      try {
        const { stdout } = await execFileAsync(config.devinExe, ['auth', 'status'],
          { timeout: 15000 });
        return json(200, { loggedIn: !/not logged in/i.test(stdout), detail: stdout.trim() });
      } catch (e) { return json(200, { loggedIn: false, detail: e.message }); }
    }
    if (url.pathname === '/api/candidates') {
      try {
        return json(200, await candidates(url.searchParams.get('force') === '1'));
      } catch (e) { return json(500, { ok: false, error: e.message }); }
    }
    if (url.pathname === '/api/goals') {
      const g = loadJson(GOALS_PATH, []);
      const repo = url.searchParams.get('repo');
      return json(200, { ok: true, goals: repo ? g.filter((x) => x.repo === repo) : g });
    }
    if (url.pathname === '/api/chat') {
      const id = +(url.searchParams.get('id') || 0);
      const s = chats.get(id);
      return json(200, s ? s.chat.snapshot() : { messages: [], sessions: sessionsList() });
    }
    if (url.pathname === '/api/chat/sessions') {
      return json(200, { sessions: sessionsList() });
    }
    if (url.pathname === '/api/skills') {
      // skills/ の *.md を一覧（既知名＋存在するファイル）
      const dir = join(ROOT, 'skills');
      const names = new Set(['_all.md', '_assess.md', '_impl.md', '_pr.md', '_split.md', '_done.md', '_survey.md']);
      try { for (const f of readdirSync(dir)) if (f.endsWith('.md')) names.add(f); } catch { /* noop */ }
      const files = [...names].sort().map((f) => ({
        name: f,
        content: (() => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } })(),
      }));
      return json(200, { files });
    }
    if (url.pathname === '/api/log') {
      const n = Math.min(parseInt(url.searchParams.get('n') ?? '200', 10) || 200, 2000);
      return json(200, { log: tailLines(LOG_PATH, n) });
    }
    if (url.pathname === '/api/tasklog') {
      // 実行中/過去セッションのログ: ?key=owner/repo issue#N → 最新一致ファイルの末尾
      const key = url.searchParams.get('key') ?? '';
      const m = key.match(/^(\S+)\s+(issue|pr)#(\d+)$/);
      if (!m) return json(400, { ok: false, error: 'bad key' });
      const prefix = `${m[1].replace('/', '_')}_${m[2]}${m[3]}`;
      const LOG_DIR = join(ROOT, 'logs');
      let files = [];
      try {
        files = readdirSync(LOG_DIR)
          .filter((f) => f.startsWith(prefix) && f.endsWith('.log'));
      } catch { /* noop */ }
      if (!files.length) return json(200, { log: '', file: null });
      files = files.map((f) => ({ f, mt: statSync(join(LOG_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mt - a.mt);
      const file = files[0].f;
      const n = Math.min(parseInt(url.searchParams.get('n') ?? '150', 10) || 150, 2000);
      return json(200, { log: tailLines(join(LOG_DIR, file), n), file });
    }
  }
  json(404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  // dispatcher は常駐前提で自動起動（各自動化はトグルフラグで制御）
  {
    const r = startDispatcher('loop');
    console.log(`[control] auto-started dispatcher: ${JSON.stringify(r)}`);
  }
  console.log(`[control] panel: http://${HOST}:${PORT}/`);
});

process.on('SIGINT', () => { child?.proc.kill(); process.exit(0); });
