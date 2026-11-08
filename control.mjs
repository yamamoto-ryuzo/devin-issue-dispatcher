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
const ISSUES_PATH = join(ROOT, 'issues.json');
const LOG_PATH = join(ROOT, 'logs', 'dispatcher.log');
const PANEL_PATH = join(ROOT, 'panel.html');

let config = loadJson(CONFIG_PATH, {});
const HOST = '127.0.0.1';
const PORT = config.controlPort ?? 8585;
const PANEL_HEADER = ['x-panel', '1'];
const SELF_ORIGIN = `http://${HOST}:${PORT}`;

// CORS: 同一オリジンと file://(Origin: null) のみ許可。
// https://evil.example 等の外部サイトからの読み書きは preflight/レスポンス読取でブロックされる
function corsOrigin(req) {
  const o = req.headers.origin;
  if (o === 'null' || o === SELF_ORIGIN) return o;
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
    chat: new AcpChat({ devinExe: config.devinExe, cwd: ROOT }),
    label: label ?? `session ${id}`,
  });
  return id;
}
// フェーズ別の上限（maxConcurrentAssess/Impl）を超えた送信は待機キューへ
const chatWait = []; // {key, mode, skill}
function busyCount(mode) {
  let n = 0;
  for (const s of chats.values()) if (s.chat.busy && s.label.endsWith(' ' + mode)) n++;
  return n;
}
function chatCapacity(mode) {
  const max = mode === 'assess'
    ? (config.maxConcurrentAssess ?? config.maxConcurrent ?? 1)
    : (config.maxConcurrentImpl ?? config.maxConcurrent ?? 1);
  return busyCount(mode) < max;
}
async function dispatchChatTask(key, mode, skill) {
  const p = taskPrompt(key, mode, skill);
  const id = pickChatId(key + ' ' + mode);
  await chats.get(id).chat.send(p.text);
  if (mode === 'assess') watchAssess(key, chats.get(id).chat);
  if (mode === 'split') watchSplit(key, chats.get(id).chat);
  return id;
}
setInterval(() => {
  for (let i = chatWait.length - 1; i >= 0; i--) {
    if (chatCapacity(chatWait[i].mode)) {
      const { key, mode, skill } = chatWait.splice(i, 1)[0];
      dispatchChatTask(key, mode, skill).catch(() => { /* noop */ });
    }
  }
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
  const modeSkill = (skillFile && /^[\w-]+\.md$/.test(skillFile)) ? skillFile : `_${mode}.md`;
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
      `"category":"auto|review|reject","partial":true|false,"reason":"理由","plan":"方針"}` +
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
    : head + `ブランチ devin/${m[2]}-${m[3]} を切り、実装→検証→push→` +
      `gh pr create（本文に Closes #${m[3]}）。main直push・force push禁止。` };
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
    // 直近の agent メッセージから判定ブロックを抽出
    for (let i = ch.messages.length - 1; i >= 0; i--) {
      const msg = ch.messages[i];
      if (msg.role !== 'agent') continue;
      const m = msg.text.match(/<!--devin-assess\s*([\s\S]*?)devin-assess-->/);
      if (!m) continue;
      try {
        const v = JSON.parse(m[1].trim());
        const st = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
        st.tasks[key] = { ...(st.tasks[key] ?? {}),
          assess: v, assessedAt: new Date().toISOString(), engine: 'chat' };
        writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
      } catch { /* malformed JSON */ }
      break;
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
      assessMaxAgeHours: config.assessMaxAgeHours ?? 24,
      autoTriggerSince: config.autoTriggerSince ?? null,
      permissionMode: config.permissionMode ?? 'dangerous',
      maxConcurrent: config.maxConcurrent ?? 1,
      maxConcurrentAssess: config.maxConcurrentAssess ?? config.maxConcurrent ?? 1,
      maxConcurrentImpl: config.maxConcurrentImpl ?? config.maxConcurrent ?? 1,
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
  // 全 open 課題数（issues.json ストア由来。repo 別の総件数表示用）
  const openCounts = {};
  for (const [key, v] of Object.entries(readIssueStore(ISSUES_PATH).issues ?? {})) {
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
      return { key, ...c, state: t?.status ?? null, assess: t?.assess ?? null };
    }),
  };
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
      'Access-Control-Allow-Headers': 'X-Panel',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  if (req.method === 'POST') {
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
          if (!st[c.key]?.assess?.category && !chatWait.some((w) => w.key === c.key)) {
            chatWait.push({ key: c.key, mode: 'assess' });
            n++;
          }
        }
        return json(200, { ok: true, queued: n });
      }
      if (url.pathname === '/api/once') {
        return json(200, startDispatcher('once'));
      }
      if (url.pathname === '/api/reload') {
        config = loadJson(CONFIG_PATH, config);
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/config') {
        // config.json の一部キーを更新（ファイル + メモリ両方）
        const allowed = ['pollIntervalSec', 'candidateCacheSec', 'maxNewPerPoll',
          'maxConcurrent', 'maxConcurrentAssess', 'maxConcurrentImpl',
          'autoDiscover', 'autoTrigger', 'autoAssess',
          'assessMaxAgeHours', 'autoTriggerSince', 'permissionMode'];
        const patch = JSON.parse((await readBody(req)) || '{}');
        const fresh = loadJson(CONFIG_PATH, config);
        const applied = {};
        for (const k of allowed) {
          if (patch[k] !== undefined) { fresh[k] = patch[k]; applied[k] = patch[k]; }
        }
        if (!Object.keys(applied).length) {
          return json(400, { ok: false, error: 'no allowed keys in patch' });
        }
        writeFileSync(CONFIG_PATH, JSON.stringify(fresh, null, 2) + '\n');
        config = fresh;
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
        try { await chats.get(sid).chat.setOption(id, value); return json(200, { ok: true }); }
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
      if (url.pathname === '/api/chat/task') {
        // パネルの「評価」「対応」ボタン → 空き/新規セッションへ自動送信
        const { key, mode, skill } = JSON.parse((await readBody(req)) || '{}');
        const p = taskPrompt(key, mode, skill);
        if (!p) return json(400, { ok: false, error: 'bad key: ' + key });
        if (p.error) return json(400, { ok: false, error: p.error });
        try {
          if (!chatCapacity(mode)) {
            chatWait.push({ key, mode, skill });
            return json(202, { ok: true, queued: true });
          }
          const id = await dispatchChatTask(key, mode, skill);
          return json(200, { ok: true, id });
        }
        catch (e) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/dispatch' || url.pathname === '/api/assess') {
        // 実行キュー登録: 実実行は Devin IDE のチャットエージェントが
        // MCP (issue-queue) 経由で queue_claim → 実行 → queue_done する
        const isAssess = url.pathname === '/api/assess';
        const { key } = JSON.parse((await readBody(req)) || '{}');
        const m = String(key ?? '').match(/^(\S+)\s+(issue|pr)#(\d+)$/);
        if (!m) return json(400, { ok: false, error: 'bad key: ' + key });
        const repo = config.repos?.find((r) => r.github === m[1]);
        if (!repo) return json(400, { ok: false, error: 'repo not monitored: ' + m[1] });
        const q = loadJson(join(ROOT, 'work-queue.json'), { items: [] });
        if (q.items.some((i) => i.key === key && i.mode === (isAssess ? 'assess' : 'impl'))) {
          return json(409, { ok: false, error: 'already queued: ' + key });
        }
        const it = readIssueStore(ISSUES_PATH).issues?.[key] ?? {};
        q.items.push({
          key, mode: isAssess ? 'assess' : 'impl',
          repo, type: m[2], number: +m[3],
          title: it.title ?? '', url: it.url ?? '', body: it.body ?? '',
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
      const names = new Set(['_all.md', '_assess.md', '_impl.md', '_split.md', '_done.md']);
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
  const desired = loadDesired();
  if (desired.enabled) {
    const r = startDispatcher('loop');
    console.log(`[control] auto-started dispatcher (desired.enabled): ${JSON.stringify(r)}`);
  }
  console.log(`[control] panel: http://${HOST}:${PORT}/`);
});

process.on('SIGINT', () => { child?.proc.kill(); process.exit(0); });
