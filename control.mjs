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
 *   GET  /api/metrics?days=7  state.json tasks の期間集計（件数・判定分布・所要時間）
 *   POST /api/start     dispatcher 起動（desired.enabled=true を永続化）
 *   POST /api/stop      dispatcher 停止（desired.enabled=false）
 *   POST /api/once      dispatcher が停止中のとき 1サイクルだけ実行
 *   POST /api/reload    config.json の読み直し（dispatcher 再起動は行わない）
 *
 * POST は `X-Panel: 1` ヘッダ必須（CSRF 対策。外部サイトのフォームからは送れない）。
 * 127.0.0.1 のみにバインドする。
 */
import { createServer } from 'node:http';
import { engineSendCore, injectExtraPrompt, ASSESS_RE, SPLIT_RE, skillEnabled,
         mcpServersForSession, apiAdapter, apiListModels } from './engine.mjs';
import { buildTaskPrompt } from './task-prompts.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, statSync, renameSync, readdirSync, mkdirSync, unlinkSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyOf, discover, toCandidate, readIssueStore, ghJson } from './discover.mjs';
import { resolveDelegatedStatus, isDelegatedStale } from './core-logic.mjs';
import { AcpChat } from './acp-chat.mjs';
import { computeMetrics } from './metrics.mjs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(ROOT, 'config.json');
const DESIRED_PATH = join(ROOT, 'desired.json');
const STATE_PATH = join(ROOT, 'state.json');
const CANDS_PATH = join(ROOT, 'candidates.json');
const GOALS_PATH = join(ROOT, 'goals.json');
const ISSUES_PATH = join(ROOT, 'issues.json');
const CHATS_PATH = join(ROOT, 'chats.json'); // チャットのラベル・エンジン・ACP sessionId（再開用）
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
// preflight/レスポンス読取でブロックされる。POST は別途 X-Panel ヘッダ必須。
// 非 loopback の許可オリジンは同一ホスト上の任意ページからもアクセス可能なため
// 読み取り専用とし、管理 POST は loopback/self/'null' に限定する。
// config.extraOrigins（配列）で許可オリジンを上書き可能（既定は GitHub Pages）
const EXTRA_ORIGINS = () => new Set(config.extraOrigins ?? ['https://yamamoto-ryuzo.github.io']);
// 非 loopback の許可オリジンからの要求か（管理 POST 拒否の判定用）
const remoteReadOnly = (req) => {
  const o = req.headers.origin;
  if (!o || o === 'null' || o === SELF_ORIGIN || !EXTRA_ORIGINS().has(o)) return false;
  try {
    const h = new URL(o).hostname.toLowerCase();
    if (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]') return false;
  } catch { /* invalid origin */ }
  return true;
};
function corsOrigin(req) {
  const o = req.headers.origin;
  if (!o) return null;
  if (o === 'null' || o === SELF_ORIGIN || EXTRA_ORIGINS().has(o)) return o;
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
// パネル内蔵チャット: ACP セッション（devin.exe acp / copilot --acp）を複数管理
const chats = new Map(); // id -> {chat: AcpChat|shim, label}
let chatSeq = 0;
// ACP で常駐セッションを張れるエンジン。それ以外は engineSend の単発 shim
const ACP_ENGINES = new Set(['devin', 'copilot']);
function sessionsList() {
  return [...chats.entries()].map(([id, s]) => ({
    id, label: s.label, busy: s.chat.busy, ready: s.chat.ready,
    live: !!s.chat.proc, sessionId: s.chat.sessionId,
    resumable: !s.chat.proc && !!s.chat.savedSessionId,
    engine: s.chat.engine ?? 'devin',
  }));
}
// 非 ACP エンジン（antigravity/api）の疑似チャット: AcpChat と同じ
// send/snapshot/clear/cancel/reset/setOption 面を単発 engineSend で実装
function makeEngineShim(eng, onError) {
  const shim = {
    engine: eng, busy: false, ready: true, proc: true, sessionId: eng,
    messages: [],
    push(role, text) {
      shim.messages.push({ role, text, ts: new Date().toISOString() });
      if (shim.messages.length > 500) shim.messages = shim.messages.slice(-400);
    },
    async send(text) {
      shim.push('user', text);
      shim.busy = true;
      try { shim.push('agent', (await engineSend(eng, text)) || ''); }
      catch (e) { shim.push('agent', '[engine error] ' + e.message); onError?.(e); }
      shim.busy = false;
      const last = shim.messages.at(-1);
      if (last?.role === 'agent') last.done = true;
    },
    snapshot() {
      return { ready: true, busy: shim.busy, error: null, live: true,
        sessionId: eng, messages: shim.messages, options: [], modes: null };
    },
    clear() { shim.messages.length = 0; },
    async cancel() { shim.busy = false; },
    async reset() { shim.messages.length = 0; },
    async close() { shim.messages.length = 0; },
    async setOption() { throw new Error(eng + ' エンジンはオプション非対応'); },
  };
  return shim;
}
// ACP オプションはエンジン別に保持（旧フラット形式 {optionId:value} は
// devin 用とみなす）。copilot/devin で optionId 空間が異なるため混ぜない
function acpOptionsOf(cfg, eng) {
  const o = cfg.acpOptions;
  if (!o) return {};
  return Object.values(o).some((v) => typeof v === 'string')
    ? (eng === 'devin' ? o : {})
    : (o[eng] ?? {});
}
// devin ACP の configOptions を一時セッションで取得するウォームアップ
// （session/new まで行うが prompt は送らず即終了。モデル一覧取得用）
async function devinConfigOptions() {
  const creds = readFileSync(
    join(homedir(), 'AppData/Roaming/devin/credentials.toml'), 'utf8');
  const apiKey = creds.match(/windsurf_api_key[ ]*=[ ]*['"]([^'"]+)['"]/)?.[1];
  if (!apiKey) throw new Error('windsurf_api_key が credentials.toml にありません');
  const proc = spawn(config.devinExe, ['acp'],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
  let seq = 0;
  const pending = new Map();
  const rpc = (method, params) => {
    const id = ++seq;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params })  + String.fromCharCode(10));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        msg.error
          ? p.rej(new Error(msg.error.message || JSON.stringify(msg.error)))
          : p.res(msg.result);
      }
    }
  });
  const timer = setTimeout(() => {
    for (const p of pending.values()) p.rej(new Error('devin acp timeout'));
    pending.clear();
    proc.kill();
  }, 45000);
  try {
    await rpc('initialize', { protocolVersion: 1,
      clientCapabilities:
        { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    await rpc('authenticate',
      { methodId: 'devin-browser', _meta: { api_key: apiKey } });
    const s = await rpc('session/new', { cwd: ROOT, mcpServers: [] });
    return s.configOptions ?? [];
  } finally { clearTimeout(timer); proc.kill(); }
}

function makeChat(eng, restored = {}) {
  return ACP_ENGINES.has(eng)
    ? new AcpChat({ engine: eng, devinExe: config.devinExe, devinExtraArgs: config.devinExtraArgs ?? [], cwd: dirname(ROOT),
        getPersistedOptions: () => acpOptionsOf(config, eng),
        // const 宣言（本ブロックより後方）を restoreChats のモジュール初期化時に
        // 参照しないよう呼び出し時まで遅延させる
        getMcpServers: () => sessionMcpServers(),
        initialSessionId: restored.sessionId ?? null,
        onSessionId: () => persistChats(),
        getStallMinutes: () => +(config.chatStallMinutes ?? 30) })
    : makeEngineShim(eng);
}
// チャットの id/ラベル/エンジン/ACP sessionId を chats.json へ永続化する。
// ACP エンジンは切断・control 再起動後も session/load で会話を再開できる。
// shim（単発応答）には再開すべきセッションが無いので sessionId は保持しない
function persistChats() {
  const o = {};
  for (const [id, s] of chats) {
    const acp = ACP_ENGINES.has(s.chat.engine ?? 'devin');
    o[id] = { label: s.label, engine: s.chat.engine ?? 'devin',
      auto: s.auto === true,
      sessionId: acp ? (s.chat.savedSessionId ?? s.chat.sessionId ?? null) : null };
  }
  const tmp = CHATS_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(o, null, 2));
  renameSync(tmp, CHATS_PATH);
}
// 空きセッションはエンジン・auto 区分一致時のみ再利用（設定切替後に旧エンジンへ
// 誤送信しない・人力チャットを委譲タスクへ転用して autoCloseChats の削除対象に
// しない）。不一致なら新規セッションを作る
function pickChatId(label, eng = 'devin', auto = false) {
  for (const [id, s] of chats) {
    if (!s.chat.busy && (s.chat.engine ?? 'devin') === eng
        && !!s.auto === auto) {
      if (label && s.label !== label) { s.label = label; persistChats(); }
      return id;
    }
  }
  const id = ++chatSeq;
  chats.set(id, { chat: makeChat(eng), label: label ?? `session ${id}`, auto });
  persistChats();
  return id;
}
// 前回プロセスのチャットを復元。ACP エンジンは savedSessionId を保持するため
// 次の送信で session/load による会話再開が試みられる（非対応/失敗時は新規）
(function restoreChats() {
  const saved = loadJson(CHATS_PATH, {});
  for (const [id, s] of Object.entries(saved)) {
    const nid = +id;
    if (!nid || !s?.engine) continue;
    chats.set(nid, { chat: makeChat(s.engine, { sessionId: s.sessionId }),
      label: s.label ?? `session ${nid}`, auto: s.auto === true });
    if (nid > chatSeq) chatSeq = nid;
  }
})();
// 委譲タスクの終端（chatResult/assess/split 確定・タイムアウト）到達時に、
// 自動生成の委譲チャット（auto フラグ + ラベル `<key> <mode>`）を畳んで
// タブ一覧から除去する。経路は /api/chat/close と同じ close → chats.delete →
// persistChats。手動 'chat' セッションは auto を持たないため対象外。
// busy 中（別キー処理へ再利用中）のものは force 指定時以外スキップする
async function closeAutoChatsForKey(key, { force = false } = {}) {
  if (config.autoCloseChats === false) return;
  const prefix = key + ' ';
  let changed = false;
  for (const [id, s] of chats) {
    if (!s.auto || !String(s.label).startsWith(prefix)) continue;
    if (s.chat.busy && !force) continue;
    try { await (s.chat.close?.() ?? s.chat.reset()); } catch { /* noop */ }
    chats.delete(id);
    changed = true;
  }
  if (changed) persistChats();
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
  // 同一リポジトリの書き込み系（impl=ローカルコミット / pr=再検証 push）は
  // 同じ作業ツリーを使うため直列化。issue と PR が同時起動して
  // commit/push が衝突するのを防ぐ
  if ((mode === 'impl' || mode === 'pr') && key) {
    const repo = key.slice(0, key.indexOf(' '));
    for (const s of chats.values()) {
      if (s.chat.busy && (s.label.endsWith(' impl') || s.label.endsWith(' pr'))
          && s.label.startsWith(repo + ' ')) {
        return false;
      }
    }
  }
  const isPr = mode === 'impl' && key ? key.includes(' pr#') : undefined;
  const max = mode === 'assess'
    ? (config.maxConcurrentAssess ?? config.maxConcurrent ?? 1)
    : (mode === 'pr' || isPr === true)
    ? (config.maxConcurrentPr ?? config.maxConcurrentImpl ?? config.maxConcurrent ?? 1)
    : (config.maxConcurrentImpl ?? config.maxConcurrent ?? 1);
  return busyCount(mode, isPr) < max;
}
// エンジン抽象層: devin=ACPチャット / copilot・antigravity=bridge-hub / api=汎用LLM(OpenAI互換)
// apiUrl は Bearer キーを送信するため、外部ホストは https 限定。
// http は loopback/LAN（プライベートアドレス）のみ許可する
// 前方一致は localhost.attacker.example のような外部ホストを通してしまうため
// 完全一致または IPv4 のアドレス範囲で判定する
function isPrivateHost(hostname) {
  const h = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]); const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
}
function assertApiUrlSafe(raw) {
  const u = new URL(raw);
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && isPrivateHost(u.hostname)) return;
  throw new Error('apiUrl は外部ホストへ https のみ許可（http は loopback/LAN 限定）: ' + raw);
}

// ハブ側のプロバイダ別 Bearer トークン（COPILOT_BRIDGE_TOKEN 等）に対応する
// 送信側トークン。secrets.json の bridgeTokens.<eng>（または共通の
// bridgeToken）優先、なければ同名環境変数をフォールバック参照する
function bridgeTokenOf(eng) {
  return secrets.bridgeTokens?.[eng] ?? secrets.bridgeToken
    ?? process.env[String(eng).toUpperCase() + '_BRIDGE_TOKEN'] ?? '';
}
// ACP session/new へ渡す MCP サーバー一覧。
// 内蔵 issue-queue（mcp-server.mjs・work-queue ツール提供）は既定エントリとして
// 常に先頭へ付け、誤削除を防ぐため config.mcpServers には含めない。
// ユーザー登録分は形状検証し、不正なものは警告してスキップする
const sessionMcpServers = () =>
  (existsSync(join(ROOT, 'mcp-server.mjs'))
    ? [{ name: 'issue-queue', command: process.execPath,
        args: [join(ROOT, 'mcp-server.mjs')], env: [] }] : [])
    .concat(mcpServersForSession(config, secrets,
      (w) => console.warn('[mcp]', w)));
async function engineSend(eng, prompt) {
  return engineSendCore(config, effectiveApiKey(), eng, prompt, bridgeTokenOf(eng));
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
  p.text = injectExtraPrompt(p.text, config.extraPrompt);
  // ツール実行往復の上限を指示文として注入（ACP/bridge/api 全経路共通）
  const tms = Math.min(Math.max(+(config.toolMaxSteps ?? 10), 1), 20);
  p.text += '\n\n【ツール往復上限】ツール実行（コマンド・ファイル編集・外部呼び出しの往復）は最大 ' + tms +
    ' 回まで。上限に達したらその時点の作業内容と未完了事項をまとめて報告し、処理を終了すること';
  const eng = resolveEngine(key, mode, engine);
  // 実際に使われたエンジンを記録（パネル/ログで追跡）
  {
    const st = loadJson(STATE_PATH, { tasks: {} });
    const next = { ...(st.tasks[key] ?? {}),
      engineUsed: eng, engineUsedAt: new Date().toISOString() };
    // エンジン障害由来の failed は新規試行開始時に解除する（再評価の成功で
    // 自動連鎖できるように。engineError 未記録＝別経路の失敗は触らない）
    if (next.status === 'failed' && next.engineError) {
      delete next.status;
      delete next.failedAt;
    }
    delete next.engineError;
    delete next.engineErrorAt;
    // dispatcher の自動起動と二重化しないよう飛行/委譲マーカーを立てる。
    // 完了は watchAssess（inflightClearedAt）/ watchImpl（chatResult）が
    // 確定して解除する（dispatcher の saveState 併合・syncShared が追従）
    if (mode === 'assess') {
      next.inflight = 'assess';
      next.inflightAt = next.engineUsedAt;
    } else if (mode === 'split') {
      next.inflight = 'split';
      next.inflightAt = next.engineUsedAt;
    } else if (mode === 'impl' || mode === 'pr') {
      next.inflight = mode;
      next.inflightAt = next.engineUsedAt;
      next.status = 'running';
      next.startedAt = next.engineUsedAt;
      next.chatDelegated = mode === 'pr' ? 'verify' : 'impl';
      next.delegatedAt = next.engineUsedAt;
    }
    st.tasks[key] = next;
    writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
  }
  if (eng === 'api' && mode !== 'assess') {
    // api エンジンは単発テキスト応答のみ。impl/split は抑止（fatal=再キューしない）
    const st0 = loadJson(STATE_PATH, { tasks: {} });
    st0.tasks[key] = { ...(st0.tasks[key] ?? {}),
      note: 'api エンジンは評価専用のため ' + mode + ' を起動しませんでした' };
    // 起動しないため直前に立てた委譲/飛行マーカーを巻き戻し、dispatcher 側へ即開放する
    delete st0.tasks[key].chatDelegated;
    delete st0.tasks[key].delegatedAt;
    delete st0.tasks[key].inflight;
    delete st0.tasks[key].inflightAt;
    st0.tasks[key].inflightClearedAt = new Date().toISOString();
    if (st0.tasks[key].status === 'running') delete st0.tasks[key].status;
    writeFileSync(STATE_PATH, JSON.stringify(st0, null, 2));
    const e = new Error('api エンジンは評価(assess)専用です。impl/split は起動できません（devin/ブリッジ系を指定してください）');
    e.fatal = true;
    throw e;
  }
  if (!ACP_ENGINES.has(eng)) {
    // 非 ACP エンジン: エンジン API への単発送信。応答を疑似チャットとして watcher に渡す
    const id = 'eng' + (++chatSeq);
    const shim = makeEngineShim(eng, (e) => {
      // エンジン障害時は判定ブロックが返らず watcher が完了を検出できないため、
      // 失敗状態をタスクへ記録して未完了のまま残さない。
      // 評価/切り分けの通信障害は engineError 欄のみに記録し、既存の
      // done/running を上書きしない。impl のみ status=failed にする
      // （失敗の発生元を engineError で区別する）
      const st = loadJson(STATE_PATH, { tasks: {} });
      const cur = st.tasks[key] ?? {};
      const now = new Date().toISOString();
      if (mode === 'impl') {
        st.tasks[key] = { ...cur, status: 'failed',
          engineError: 'engine error: ' + e.message, failedAt: now };
      } else {
        st.tasks[key] = { ...cur,
          engineError: 'engine error (' + mode + '): ' + e.message,
          engineErrorAt: now };
      }
      // 失敗した委譲/飛行マーカーは解除し、再試行や dispatcher 経路を開放する
      delete st.tasks[key].chatDelegated;
      delete st.tasks[key].delegatedAt;
      delete st.tasks[key].chatId;
      delete st.tasks[key].inflight;
      delete st.tasks[key].inflightAt;
      st.tasks[key].inflightClearedAt = now;
      writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
    });
    chats.set(id, { chat: shim, label: key + ' ' + mode, auto: true });
    shim.busy = true;
    shim.send(p.text).catch(() => {});
    recordChatId(key, id); // 全モードで記録（engN セッション後追い用）
    if (mode === 'assess') watchAssess(key, shim);
    if (mode === 'split') watchSplit(key, shim);
    if (mode === 'impl' || mode === 'pr') watchImpl(key, shim);
    return id;
  }
  const id = pickChatId(key + ' ' + mode, eng, true);
  try {
    await chats.get(id).chat.send(p.text);
  } catch (e) {
    unmarkDelegated(key); // 未起動のまま委譲マーカーを残さない
    // 起動しなかった自動生成セッションは監視も付かず残るため畳む
    closeAutoChatsForKey(key).catch(() => {});
    throw e;
  }
  if (mode === 'impl' || mode === 'pr') recordChatId(key, id);
  if (mode === 'assess') watchAssess(key, chats.get(id).chat);
  if (mode === 'split') watchSplit(key, chats.get(id).chat);
  if (mode === 'impl' || mode === 'pr') watchImpl(key, chats.get(id).chat);
  return id;
}

// 委譲実行への停止要求（kill-requests → /api/chat/cancel）転送用に、
// 起動したセッション id を state へ記録する
function recordChatId(key, id) {
  const st = loadJson(STATE_PATH, { tasks: {} });
  if (!st.tasks[key]?.chatDelegated) return;
  st.tasks[key].chatId = id;
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

// chatWait 投入時点で立てる飛行マーカー。投入→起動の隙間に dispatcher が
// 同一課題を自動起動するのを防ぐ（委譲本体は dispatchChatTask 起動時に立つ）
function markQueued(key, mode) {
  const st = loadJson(STATE_PATH, { tasks: {} });
  const t = st.tasks[key] ?? {};
  if (t.inflight || t.chatDelegated || t.status === 'running') return;
  st.tasks[key] = { ...t, inflight: mode, inflightAt: new Date().toISOString() };
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

// 起動不能（fatal）で飛行マーカーだけ残った場合の巻き戻し。
// 委譲起動済み（chatDelegated）なら完了監視・滞留回収側へ委ねる
function unmarkQueued(key) {
  const st = loadJson(STATE_PATH, { tasks: {} });
  const t = st.tasks[key];
  if (!t?.inflight || t.chatDelegated) return;
  delete t.inflight;
  delete t.inflightAt;
  t.inflightClearedAt = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

// dispatch 自体の失敗（送信不可等）で立てた委譲/飛行マーカーを巻き戻す。
// status/startedAt は今回の dispatch が立てたもの（engineUsedAt と一致）のみ解除し、
// 既存の dispatcher 実行中タスクの running 表示は壊さない
function unmarkDelegated(key) {
  const st = loadJson(STATE_PATH, { tasks: {} });
  const t = st.tasks[key];
  if (!t) return;
  const ownRun = t.status === 'running' && t.startedAt && t.startedAt === t.engineUsedAt;
  delete t.chatDelegated;
  delete t.delegatedAt;
  delete t.chatId;
  delete t.inflight;
  delete t.inflightAt;
  t.inflightClearedAt = new Date().toISOString();
  if (ownRun) { delete t.status; delete t.startedAt; }
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}
setInterval(() => {
  // busy が立つ前に同じチャットを再選択しないよう await し、失敗時はキューへ戻す
  (async () => {
    for (let i = chatWait.length - 1; i >= 0; i--) {
      if (!chatCapacity(chatWait[i].mode, chatWait[i].key)) continue;
      const { key, mode, skill, engine } = chatWait.splice(i, 1)[0];
      try { await dispatchChatTask(key, mode, skill, engine); }
      catch (e) {
        if (!e?.fatal) { chatWait.push({ key, mode, skill, engine }); markQueued(key, mode); }
        else unmarkQueued(key); // 起動不能 → 待機時の飛行マーカーを戻す
      }
    }
  })();
}, 3000).unref?.();

// 課題プロンプトの本文生成は task-prompts.mjs に集約（dispatcher と同一正本）。
// ここでは課題キーの解決と issue ストアからの詳細補完のみを行う
function taskPrompt(key, mode, skillFile) {
  const m = String(key ?? '').match(/^(\S+)\s+(issue|pr)#(\d+)$/);
  if (!m) return null;
  const repo = config.repos?.find((r) => r.github === m[1]);
  if (!repo) return { error: 'repo not monitored: ' + m[1] };
  const it = readIssueStore(ISSUES_PATH).issues?.[key] ?? {};
  const task = { repo, type: m[2], number: +m[3],
    title: it.title ?? '', body: it.body ?? '', url: it.url ?? '' };
  return { key, text: buildTaskPrompt({ ROOT, config, task, mode, skillFile,
    implLoopMax: config.implLoopMax ?? 5 }) };
}

// Issue 添付を監視リポジトリ内のアセットブランチへ格納し、本文埋め込み用リンクを返す
// （gh issue create は添付非対応のため contents API + raw URL を使う）
const ISSUE_ASSETS_BRANCH = 'devin-issue-assets';
// 添付ファイル名へ補完する拡張子（拡張子なしの貼付画像等用）
const ATTACH_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
  'text/plain': '.txt', 'text/markdown': '.md' };
// 添付 data URL のデコードとファイル名のサニタイズ（issue 添付・chat 添付で共通）
function decodeAttachment(a) {
  const m = /^data:([^;,]+)?;base64,(.+)$/s.exec(String(a?.data || ''));
  if (!m) throw new Error('bad attachment data');
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  let base = String(a.name || '').split(/[\\/]/).pop()
    .replace(/[^\w.+-]+/g, '_').replace(/^_+|_+$/g, '').slice(-80);
  if (!base) base = 'file';
  if (!/\.[A-Za-z0-9]{1,8}$/.test(base) && ATTACH_EXT[mime]) base += ATTACH_EXT[mime];
  return { mime, base, buf: Buffer.from(m[2].replace(/\s+/g, ''), 'base64') };
}
// チャット添付を chat-uploads/ へ保存し {name, path} を返す。
// ACP エージェント（cwd=ROOT の親）がローカルファイルとして読めるよう絶対パスで返し、
// 送信テキスト側が [添付] name → path 行を付記する（steer 経路も同仕組み）
const CHAT_UPLOADS_DIR = join(ROOT, 'chat-uploads');
function saveChatAttachments(atts) {
  if (!Array.isArray(atts) || !atts.length) return [];
  mkdirSync(CHAT_UPLOADS_DIR, { recursive: true });
  return atts.slice(0, 10).map((a) => {
    const { base, buf } = decodeAttachment(a);
    const fp = join(CHAT_UPLOADS_DIR, Date.now() + '_' +
      Math.random().toString(36).slice(2, 7) + '_' + base);
    writeFileSync(fp, buf);
    return { name: base, path: fp };
  });
}
const ghApi = (args) => new Promise((res, rej) => {
  execFile('gh', ['api', ...args],
    (e, so, se) => e ? rej(new Error(String(se || e.message).trim())) : res(so));
});
async function issueAssetLinks(repo, atts) {
  try {
    await ghApi(['repos/' + repo + '/git/ref/heads/' + ISSUE_ASSETS_BRANCH]);
  } catch {
    const def = JSON.parse(await ghApi(['repos/' + repo])).default_branch;
    const sha = JSON.parse(
      await ghApi(['repos/' + repo + '/git/ref/heads/' + def])).object.sha;
    await ghApi(['repos/' + repo + '/git/refs',
      '-f', 'ref=refs/heads/' + ISSUE_ASSETS_BRANCH, '-f', 'sha=' + sha]);
  }
  const links = [];
  for (const a of atts.slice(0, 10)) {
    const { mime, base, buf } = decodeAttachment(a);
    const fp = 'issue-assets/' + Date.now() + '_' +
      Math.random().toString(36).slice(2, 7) + '_' + base;
    // base64 はコマンド行上限を超え得るため --input の一時ファイルで渡す
    const tmp = join(tmpdir(), 'issasset_' + process.pid + '_' + links.length + '.json');
    writeFileSync(tmp, JSON.stringify({
      message: 'chore: add issue attachment ' + base,
      content: buf.toString('base64'),
      branch: ISSUE_ASSETS_BRANCH }));
    try {
      await ghApi(['repos/' + repo + '/contents/' + fp, '-X', 'PUT', '--input', tmp]);
    } finally { try { unlinkSync(tmp); } catch { /* noop */ } }
    const u = 'https://github.com/' + repo + '/raw/' + ISSUE_ASSETS_BRANCH + '/' + fp;
    links.push(mime.startsWith('image/')
      ? '![' + base + '](' + u + ')'
      : '[' + base + '](' + u + ')');
  }
  return links;
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
// watcher の 30 分タイムアウト記録。inflight が残っている（=完了検出できなかった）
// 場合に state へ記録し issue/pr コメントでも通知する。完了済みは何もしない
// 委譲 impl/verify の終端状態を gh の実状態から判定する共通経路
// （watchImpl の通常完了・recordWatchTimeout・起動時走査で同じ規則を使う）
async function queryDelegatedStatus(key, delegated) {
  const m = key.match(/^(\S+)\s+(issue|pr)#(\d+)$/);
  if (!m) return 'done'; // pr#N 課題（旧経路）
  try {
    const cur = await ghJson([m[2], 'view', m[3], '-R', m[1], '--json', 'state,labels']);
    return resolveDelegatedStatus(delegated, {
      state: cur.state,
      labels: (cur.labels ?? []).map((l) => l.name ?? l),
      flag: config.implDoneLabel ?? 'AI:impl-done',
      isPr: m[2] === 'pr' });
  } catch { return 'needs-review'; } // 確認失敗 → 人間へ回す
}

// 委譲 impl/verify の滞留タスクを gh 実状態で終端解決する。
// マーカーを消すのではなく chatResult を書く方式に統一し、status 確定・
// ラベル適用・verify-ng エスカレーションを dispatcher の消費経路へ一本化する
async function resolveDelegatedEnd(key, via) {
  const t = loadJson(STATE_PATH, { tasks: {} }).tasks[key];
  if (!t?.chatDelegated || t.chatResult) return;
  const status = await queryDelegatedStatus(key, t.chatDelegated);
  const st = loadJson(STATE_PATH, { tasks: {} });
  const cur = st.tasks[key];
  if (!cur?.chatDelegated || cur.chatResult) return; // 競合時は既存結果優先
  const at = new Date().toISOString();
  st.tasks[key] = { ...cur,
    chatResult: { status, at, via }, inflightClearedAt: at };
  delete st.tasks[key].inflight;
  delete st.tasks[key].inflightAt;
  delete st.tasks[key].chatId;
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
  // 終端確定した委譲タスクの自動生成セッションを畳む（watcher 不在の
  // タイムアウト/起動時走査経路では busy が残りうるため強制）
  closeAutoChatsForKey(key, { force: true }).catch(() => {});
}

function recordWatchTimeout(key, mode) {
  const st = loadJson(STATE_PATH, { tasks: {} });
  const t = st.tasks[key];
  // 委譲 impl/verify は chatDelegated が正マーカー（inflight は別経路で
  // 途中解除されることがある）。どちらか残っていればタイムアウト処理する
  if (!t || (!t.inflight && !t.chatDelegated) || t?.chatResult || t?.splitTo) return;
  const now = new Date().toISOString();
  st.tasks[key] = { ...t,
    watchTimeout: mode, watchTimeoutAt: now,
    engineError: 'watch timeout (' + mode + '): 30分応答なし',
    engineErrorAt: now, inflightClearedAt: now };
  delete st.tasks[key].inflight;
  delete st.tasks[key].inflightAt;
  writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
  // タイムアウトで打ち切ったタスクの自動生成セッションも畳む
  // （30分無応答のターンは残しても再開しないため強制クローズ）
  closeAutoChatsForKey(key, { force: true }).catch(() => {});
  // 委譲 impl/verify は「マーカー掃除」ではなく「終端解決」を行う。
  // gh 実状態で chatResult を書き、dispatcher の消費経路（status 確定・
  // ラベル適用）へ載せる。書かないと委譲マーカーが残り永久に SKIP される
  if (t.chatDelegated === 'impl' || t.chatDelegated === 'verify') {
    resolveDelegatedEnd(key, 'watch-timeout').catch(() => {});
  }
  const m = key.match(/^([^ ]+) +(issue|pr)#([0-9]+)$/);
  if (m) {
    ghJson([m[2], 'comment', m[3], '-R', m[1], '--body',
      '[watcher] ' + mode + ' セッションが30分応答なしでタイムアウトしました'])
      .catch(() => {});
  }
}

function watchAssess(key, ch) {
  if (assessWatchers.has(key)) return;
  assessWatchers.add(key);
  const iv = setInterval(() => {
    if (ch.busy) return;
    clearInterval(iv);
    assessWatchers.delete(key);
    clearTimeout(to);
    // 直近の agent メッセージ群（最大8件）から判定ブロックを横断検出
    // （<!--split--> は切り分けセッション専用の出力で、評価セッションは出さない）
    let scanned = 0;
    for (let i = ch.messages.length - 1; i >= 0 && scanned < 8; i--) {
      const msg = ch.messages[i];
      if (msg.role !== 'agent') continue;
      scanned++;
      const m = msg.text.match(ASSESS_RE);
      if (!m) continue;
      try {
        const v = JSON.parse(m[1].trim());
        const st = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
        st.tasks[key] = { ...(st.tasks[key] ?? {}),
          assess: v, assessedAt: new Date().toISOString(), engine: 'chat' };
        // 正常な判定が得られたら過去のエンジン障害記録を整理し、
        // failed-by-engine が残っていれば解除して自動連鎖を解放する
        if (st.tasks[key].status === 'failed' && st.tasks[key].engineError) {
          delete st.tasks[key].status;
          delete st.tasks[key].failedAt;
        }
        delete st.tasks[key].engineError;
        delete st.tasks[key].engineErrorAt;
        // dispatcher 委譲の自動評価が立てた inflight マーカーを解除（多重キュー抑止の解除）
        // 解除時刻を残し、dispatcher がメモリ上のマーカーへ新しさで追従できるようにする
        delete st.tasks[key].inflight;
        st.tasks[key].inflightClearedAt = new Date().toISOString();
        // 自動連鎖: issue課題は autoTrigger、pr課題は autoPr が ON のとき
        // 判定・リスクが自動処理範囲内なら次セッションへ投入。
        // partial=true はまず切り分け（残作業は分割先 issue が引き継ぐ。
        // splitAt は多重切り分け防止の試行マーカー）
        const autoOk = key.includes(' pr#')
          ? (config.autoPr ?? false) : (config.autoTrigger ?? false);
        const chainable = autoOk && catAllowed(v.category) && riskAllowed(v.risk) &&
            !['running', 'done', 'failed', 'needs-review', 'rejected', 'closed'].includes(st.tasks[key]?.status) &&
            !st.tasks[key]?.chatDelegated &&
            !chatWait.some((w) => w.key === key);
        const partial = v.partial === true || v.partial === 'true';
        const chainMode = partial && !st.tasks[key]?.splitAt ? 'split' : 'impl';
        if (chainable) {
          st.tasks[key].inflight = chainMode;
          st.tasks[key].inflightAt = new Date().toISOString();
        }
        writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
        if (chainable) chatWait.push({ key, mode: chainMode });
      } catch { /* malformed JSON */ }
      break;
    }
    // 評価ターン終了 = 委譲タスクの終端。自動生成セッションは畳む
    closeAutoChatsForKey(key).catch(() => {});
  }, 3000);
  // 30分で強制終了。完了検出前に応答が途絶えた場合は失敗として記録する
  const to = setTimeout(() => {
    clearInterval(iv); assessWatchers.delete(key);
    recordWatchTimeout(key, 'assess');
  }, 30 * 60 * 1000).unref?.();
}

// 切り分け完了を監視: <!--split {"newKey":...}--> を検出したら新 issue を自動再評価
function watchSplit(key, ch) {
  const iv = setInterval(() => {
    if (ch.busy) return;
    clearInterval(iv);
    clearTimeout(to);
    let blk = null;
    for (let i = ch.messages.length - 1; i >= 0; i--) {
      const msg = ch.messages[i];
      if (msg.role !== 'agent') continue;
      const m = msg.text.match(SPLIT_RE);
      if (!m) continue;
      try { blk = JSON.parse(m[1].trim()); } catch { /* noop */ }
      break;
    }
    // 試行マーカー splitAt を記録（多重切り分け防止）し inflight を解除。
    // ブロック無し・newKey 無し（NG/起票失敗）でも課題を再処理可能に戻す
    {
      const now = new Date().toISOString();
      const st = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
      st.tasks[key] = { ...(st.tasks[key] ?? {}),
        splitAt: now, ...(blk?.newKey ? { splitTo: blk.newKey } : {}),
        inflightClearedAt: now };
      delete st.tasks[key].inflight;
      delete st.tasks[key].inflightAt;
      writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
    }
    if (blk?.newKey) {
      // エンジン非依存に切り分け先を再評価（非 devin の疑似チャットには send が
      // 無いため dispatchChatTask 経由でエンジン解決・監視へ委ねる）
      Promise.resolve(dispatchChatTask(blk.newKey, 'assess', null)).catch(() => {});
    }
    // 切り分けターン終了。後続は dispatchChatTask 経由の別セッションへ移るため畳む
    closeAutoChatsForKey(key).catch(() => {});
  }, 3000);
  const to = setTimeout(() => { clearInterval(iv);
    recordWatchTimeout(key, 'split'); }, 30 * 60 * 1000).unref?.();
}

// 対応完了を監視: 委譲 impl/verify セッションの終了時に issue の状態から status を確定する
// （impl: AI:impl-done 有=impl-done / 無=needs-review、
//   verify: close=done / flag残=impl-done(再検証) / flag除去=verify-ng）
const implWatchers = new Set();
function watchImpl(key, ch) {
  if (implWatchers.has(key)) return;
  implWatchers.add(key);
  const iv = setInterval(() => {
    if (ch.busy) return;
    clearInterval(iv);
    implWatchers.delete(key);
    clearTimeout(to);
    // ターン終了 = 委譲タスクの終端。自動生成の委譲セッションを畳む
    closeAutoChatsForKey(key).catch(() => {});
    // dispatcher から委譲された自動 impl/verify: chat 完了時に status を確定する。
    // dispatcher は chatResult と inflightClearedAt を読んで滞留中の委譲マーカーを解除する
    const st0 = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
    const delegated = st0.tasks[key]?.chatDelegated;
    if (delegated !== 'impl' && delegated !== 'verify') return;
    (async () => {
      const status = await queryDelegatedStatus(key, delegated);
      const st = loadJson(STATE_PATH, { deployedAt: null, tasks: {} });
      const at = new Date().toISOString();
      st.tasks[key] = { ...st.tasks[key],
        chatResult: { status, at }, inflightClearedAt: at };
      delete st.tasks[key].inflight;
      delete st.tasks[key].chatId;
      writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
    })();
  }, 3000);
  const to = setTimeout(() => { clearInterval(iv); implWatchers.delete(key);
    // 応答なしのまま放置された委譲セッションを止める（トークン垂れ流し防止）
    try { ch.cancel?.(); } catch { /* noop */ }
    recordWatchTimeout(key, 'impl'); }, 30 * 60 * 1000).unref?.();
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
      apiProvider: config.apiProvider ?? 'openai',
      apiVersion: config.apiVersion ?? '',
      apiModels: config.apiModels ?? {},
      bridgeModels: config.bridgeModels ?? {},
      plugins: config.plugins ?? [],
      mcpServers: config.mcpServers ?? [],
      apiKeySet: !!effectiveApiKey(), // 値自体は返さない（hasValue のみ）
      extraPrompt: config.extraPrompt ?? '',
      repos: (config.repos || []).map((r) => r.github),
      assessMaxAgeHours: config.assessMaxAgeHours ?? 24,
      autoTriggerSince: config.autoTriggerSince ?? null,
      permissionMode: config.permissionMode ?? 'dangerous',
      toolMaxSteps: config.toolMaxSteps ?? 10,
      maxConcurrent: config.maxConcurrent ?? 1,
      maxConcurrentAssess: config.maxConcurrentAssess ?? config.maxConcurrent ?? 1,
      maxConcurrentImpl: config.maxConcurrentImpl ?? config.maxConcurrent ?? 1,
      implLoopMax: config.implLoopMax ?? 5,
      maxConcurrentPr: config.maxConcurrentPr ?? config.maxConcurrentImpl ?? config.maxConcurrent ?? 1,
      maxNewPerPoll: config.maxNewPerPoll ?? 50,
      autoCloseChats: config.autoCloseChats !== false,
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
    implDone: config.implDoneLabel ?? 'AI:impl-done',
  };
}

function writeCandsCache(items) {
  const fetchedAt = new Date().toISOString();
  const tmp = CANDS_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify({ fetchedAt, candidates: items }, null, 2));
  renameSync(tmp, CANDS_PATH);
  return fetchedAt;
}

// open PR の本文から close/fix/resolve #N（または owner/repo#N）参照を抽出する。
// パネルで「親 issue に対応する open PR」を表示するための派生データ用
function closingIssueNums(body, repo) {
  const out = new Set();
  const re = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:(\S+)#|#)(\d+)/gi;
  for (const m of body.matchAll(re)) {
    if (m[1] && m[1] !== repo) continue; // 別 repo を指す close 参照は対象外
    out.add(+m[2]);
  }
  return [...out];
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
  // open 中の全課題キー（createdPr が今も open かの判定用）と、
  // open PR 本文の close 参照から「親issue → PR」の逆引きマップ
  const openKeys = new Set(Object.keys(issuesAll));
  const prToIssue = new Map();
  for (const [k, v] of Object.entries(issuesAll)) {
    if (v.type !== 'pr') continue;
    for (const n of closingIssueNums(v.body ?? '', v.repo)) {
      const ik = keyOf(v.repo, 'issue', n);
      if (!prToIssue.has(ik)) prToIssue.set(ik, k);
    }
  }
  return {
    fetchedAt, cached,
    autoEnabled: config.autoTrigger ?? false,
    discoverEnabled: config.autoDiscover ?? true,
    openCounts,
    candidates: raw.map((c) => {
      const key = keyOf(c.repo, c.type, c.number);
      const t = state.tasks?.[key];
      // 別リポジトリの createdPr は共有チャット履歴の誤検出なので破棄
      let createdPr = t?.createdPr ?? null;
      if (createdPr && !String(createdPr).startsWith(c.repo + ' ')) createdPr = null;
      // 現在 open の関連 PR: 記録済みが open ならそれ、無ければ close 参照から補完
      const openPr = c.type === 'issue'
        ? ((createdPr && openKeys.has(createdPr)) ? createdPr
          : prToIssue.get(key) ?? null)
        : null;
      return { key, ...c, state: t?.status ?? null, assess: t?.assess ?? null,
        // dispatcher 直接起動の devin セッションは chatBusy に載らないため、
        // 実行フェーズをパネル表示用にそのまま出す（対応列の「○○中」表示に使う）
        phase: t?.phase ?? null, inflight: t?.inflight ?? null,
        chatDelegated: t?.chatDelegated ?? null,
        queued: t?.queued ?? null,
        createdPr, openPr,
        engineReq: t?.engineReq ?? null,
        engineIssue: issueEngine(key, issuesAll),
        engine: resolveEngine(key, null, null, state.tasks, issuesAll),
        engineImpl: resolveEngine(key, 'impl', null, state.tasks, issuesAll),
        engineUsed: t?.engineUsed ?? null };
    }),
  };
}

// ---- MCP (Streamable HTTP): 管理系ツールを外部 MCP クライアントへ公開 ----
// /mcp は X-Panel を課さない（MCP クライアントはカスタムヘッダを送れない想定）。
// ただし secrets.panelToken 設定時は /mcp でもトークンを要求する
// （Origin 無しの内部プロキシ経由で管理操作を迂回されるのを防ぐ）。
// Content-Type: application/json の POST はブラウザでは preflight 必須のため、
// 未許可オリジンは CORS で既に遮断される。127.0.0.1 バインドで外部直叩き不可。
// tools/call は自前の /api/* へ内部プロキシし、権限・検証ロジックを単一実装に保つ。
// 非 loopback の許可オリジンからの呼出は readOnlyHint のツールに限定する
// （内部プロキシに Origin が引き継がれないため /api/* 側の読み取り専用判定を
// 迂回できる穴を塞ぐ）。
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
    description: '課題を作業キューへ登録（実装。評価 assess はスキップして直接実装）。IDE エージェントが MCP(issue-queue) 経由で取り出して実行',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM, engine: { type: 'string', description: 'devin/copilot/antigravity/api' } }, required: ['key'] },
    api: { method: 'POST', path: '/api/dispatch' } },
  { name: 'assess', annotations: WR,
    description: '課題を評価キューへ登録（評価のみ・実装しない）',
    inputSchema: { type: 'object', properties: { key: KEY_PARAM, engine: { type: 'string' } }, required: ['key'] },
    api: { method: 'POST', path: '/api/assess' } },
  { name: 'chat_task', annotations: WR,
    description: '課題をエンジンセッションで即時実行（assess=評価/impl=実装/split=切り分け。impl は評価をスキップして直接実装）',
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

// ---- AI チャット（CANVAS の AI タブ相当）----
// OpenAI 互換 LLM のツール呼出ループ。ツール面は MCP_TOOLS を OpenAI tools
// 形式で公開し、実行は mcpToolCall（自前 /api/* への内部プロキシ）で
// 権限・検証ロジックを単一実装に保つ。
async function aiChat(messages, maxSteps) {
  const url = (config.apiUrl || '').replace(/\/+$/, '');
  if (!url || !config.apiModel)
    throw new Error('apiUrl/apiModel 未設定（設定タブ「AI」で指定）');
  assertApiUrlSafe(url);
  // ツール呼出ループは OpenAI 形式の tool_calls が前提のため anthropic は
  // 明示エラー（課題処理の単発送信 engineSend は全プロバイダ対応済み）
  const apiProvider = String(config.apiProvider ?? 'openai').toLowerCase();
  if (apiProvider === 'anthropic')
    throw new Error('内蔵チャットのツールループは anthropic 未対応です（課題処理の api 送信は対応済み）');
  const ad = apiAdapter(config);
  const limit = Math.min(Math.max(+maxSteps || +(config.toolMaxSteps ?? 10), 1), 20);
  const tools = MCP_TOOLS.map((t) => ({ type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const msgs = [{ role: 'system',
    content: 'あなたは Devin Agent Dispatcher の管理アシスタントです。' +
      '課題一覧・状態確認・評価/対応のディスパッチ・設定参照などは提供ツールを使い、' +
      '結果を日本語で簡潔に報告してください。' +
      'kill・issue_close・stop などの破壊的ツールはユーザーが明示した場合のみ実行してください。' },
    ...messages];
  const calls = [];
  for (let step = 0; step < limit; step++) {
    const r = await fetch(ad.chatUrl(url, config), {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json',
        ...ad.headers(effectiveApiKey()) },
      // azure はデプロイメントが URL 内のため model フィールドを送らない
      body: JSON.stringify({ ...(apiProvider === 'azure' ? {} : { model: config.apiModel }),
        messages: msgs, tools }),
    });
    // Bearer キーがリダイレクト先の平文 http へ漏れないよう自動追跡しない
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
      throw new Error('api リダイレクトは拒否されます（https 直結のみ許可）: ' + (r.status || r.type));
    }
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'api ' + r.status);
    const m = j.choices?.[0]?.message ?? {};
    const tcs = m.tool_calls ?? [];
    if (!tcs.length) return { ok: true, reply: m.content || '', calls, steps: step + 1 };
    msgs.push({ role: 'assistant', content: m.content ?? null, tool_calls: tcs });
    for (const tc of tcs) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* noop */ }
      const tool = MCP_TOOLS.find((t) => t.name === name);
      let out;
      if (!tool) out = { error: 'unknown tool: ' + name };
      else { try { out = await mcpToolCall(tool, args); }
        catch (e) { out = { error: String(e?.message ?? e) }; } }
      calls.push({ name, args, result: out });
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
    }
  }
  return { ok: true, reply: '（ツール往復上限に達しました）', calls, steps: limit, truncated: true };
}

async function handleMcp(req, res, acao, readOnly = false) {
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
      tools: MCP_TOOLS
        .filter((t) => !readOnly || t.annotations?.readOnlyHint === true)
        .map((t) => ({
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
    if (readOnly && tool.annotations?.readOnlyHint !== true) {
      return text({ error: 'non-loopback origin is read-only' }, true);
    }
    try {
      const out = await mcpToolCall(tool, msg.params?.arguments ?? {});
      return text(out, out?.ok === false);
    } catch (e) {
      return text({ error: String(e?.message ?? e) }, true);
    }
  }
  return error(-32601, `method not found: ${method}`);
}

// ---- SSE: 状態変化の push 配信 ----
// パネルの常時ポーリングを避けつつ「状態変化→即時反映」を実現するため、
// state.json 等の書き込みを fs.watch で検出して GET /api/events へ配信する。
// dispatcher.mjs は別プロセスだが同一ファイルを書き換えるため監視で捕捉できる
const sseClients = new Set();
let stateWatcher = null, sseTimer = null;
const SSE_WATCH_FILES = new Set(
  ['state.json', 'candidates.json', 'issues.json', 'desired.json', 'chats.json']);
function sseBroadcast(obj) {
  const data = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of sseClients) { try { res.write(data); } catch { /* noop */ } }
}
function ensureStateWatcher() {
  if (stateWatcher) return;
  try {
    // 監視対象はファイル単位ではなくディレクトリ: state.json は tmp+rename の
    // 原子書き換えのため、ファイル監視だと rename 後に監視が外れる
    stateWatcher = watch(ROOT, { persistent: false }, (_ev, filename) => {
      if (!filename || !SSE_WATCH_FILES.has(filename)) return;
      if (sseTimer) clearTimeout(sseTimer);
      sseTimer = setTimeout(() => {
        sseTimer = null;
        sseBroadcast({ type: 'state', file: filename, at: new Date().toISOString() });
      }, 400);
    });
    stateWatcher.on('error', () => { stateWatcher = null; });
  } catch { /* 監視不可環境では無イベントのまま（パネル側は周期取得へフォールバック） */ }
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
    if (url.pathname === '/mcp') {
      // ブラウザ単純 POST による CSRF 遮断: JSON-RPC は application/json 必須
      // （外部サイトは preflight なしで送れない）。Origin 付きで非許可なら拒否
      const ct = String(req.headers['content-type'] || '');
      if ((req.headers.origin && !acao) || !ct.includes('application/json')) {
        return json(403, { ok: false, error: 'forbidden' });
      }
      // panelToken 設定時: Origin 無しのプロキシ経由も含め /mcp の全 POST に
      // トークンを要求。MCP クライアントは X-Panel-Token か
      // Authorization: Bearer <panelToken> を設定すること
      if (secrets.panelToken &&
          req.headers['x-panel-token'] !== secrets.panelToken &&
          req.headers.authorization !== `Bearer ${secrets.panelToken}`) {
        return json(403, { ok: false, error: 'invalid panel token' });
      }
      // 非 loopback の許可オリジンは読み取り専用（/api/* POST と同じ思想）
      return await handleMcp(req, res, acao, remoteReadOnly(req));
    }
    // CSRF: カスタムヘッダ必須。preflight は行わないので外部サイトからは送信不可
    if (req.headers[PANEL_HEADER[0]] !== PANEL_HEADER[1]) {
      return json(403, { ok: false, error: 'missing X-Panel header' });
    }
    // 非 loopback オリジン（CDN ホスト版等）は読み取り専用。同一ホスト上の
    // 任意ページからの管理操作を防ぐため管理 POST は loopback/self/'null' 限定
    if (remoteReadOnly(req)) {
      return json(403, { ok: false, error: 'non-loopback origin is read-only' });
    }
    // ローカル Web ページからのなりすまし対策（任意強化）: secrets.json に
    // panelToken を設定した場合、自サーバ外オリジンからの POST は
    // X-Panel-Token 一致を要求（ブラウザのページは secrets.json を読めない。
    // file:// の 'null' オリジンも対象 — 設定時はパネルを http://127.0.0.1:<port>
    // 経由で利用し、連携ローカルツールへも同トークンを設定する）
    {
      const o = req.headers.origin;
      if (secrets.panelToken && o && o !== SELF_ORIGIN &&
          req.headers['x-panel-token'] !== secrets.panelToken) {
        return json(403, { ok: false, error: 'invalid X-Panel-Token' });
      }
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
            markQueued(key, 'assess');
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
          if (s === 'running' || s === 'done' || s === 'needs-review' || s === 'rejected' || s === 'closed') continue;
          if (chatWait.some((w) => w.key === key)) continue;
          chatWait.push({ key, mode: 'impl' });
          markQueued(key, 'impl');
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
          'autoDiscover', 'autoTrigger', 'autoTriggerMode', 'trustedAuthors', 'autoIssueOnFailure', 'failureDedupeHours', 'autoAssess', 'autoPr', 'autoCategory',
          'maxAutoRisk',
          'assessMaxAgeHours', 'autoTriggerSince', 'permissionMode', 'implLoopMax',
          'engine', 'bridgeHub', 'apiUrl', 'apiModel', 'extraPrompt', 'extraOrigins',
          'toolMaxSteps', 'apiModels', 'bridgeModels', 'acpOptions', 'plugins',
          'mcpServers', 'apiProvider', 'apiVersion',
          'chatStallMinutes', 'delegatedSweepMinutes', 'autoCloseChats'];
        const patch = JSON.parse((await readBody(req)) || '{}');
        const fresh = loadJson(CONFIG_PATH, config);
        // apiProvider は実装済みアダプタの種別のみ受理
        if (patch.apiProvider !== undefined &&
            !['openai', 'anthropic', 'azure'].includes(String(patch.apiProvider))) {
          return json(400, { ok: false, error: 'apiProvider は openai/anthropic/azure のみ' });
        }
        // mcpServers は ACP 形式 [{name,command|url,...}] のみ受理
        if (patch.mcpServers !== undefined && !(Array.isArray(patch.mcpServers) &&
            patch.mcpServers.every((e) => e && typeof e === 'object' &&
              typeof e.name === 'string' && e.name.length >= 1 && e.name.length <= 100 &&
              (typeof e.command === 'string' || typeof e.url === 'string')))) {
          return json(400, { ok: false, error: 'mcpServers は [{name,command|url,...}] の配列のみ' });
        }
        // plugins は拡張レジストリ [{type,name,enabled}] のみ受理
        if (patch.plugins !== undefined && !(Array.isArray(patch.plugins) &&
            patch.plugins.every((e) => e && typeof e === 'object' &&
              typeof e.type === 'string' && /^[\w-]{1,40}$/.test(e.type) &&
              typeof e.name === 'string' && e.name.length >= 1 && e.name.length <= 200 &&
              typeof e.enabled === 'boolean'))) {
          return json(400, { ok: false, error: 'plugins は [{type,name,enabled}] の配列のみ' });
        }
        // apiUrl は Bearer 送信先: 外部ホストの http 平文送信を保存時に拒否
        if (patch.apiUrl !== undefined && patch.apiUrl) {
          try { assertApiUrlSafe(String(patch.apiUrl)); }
          catch (e) { return json(400, { ok: false, error: e.message }); }
        }
        const applied = {};
        // シークレット類は secrets.json（Git 管理外）へ保存。config.json には書かない
        if (patch.apiKey !== undefined) {
          const sec = loadJson(SECRETS_PATH, {});
          if (patch.apiKey) sec.apiKey = String(patch.apiKey); else delete sec.apiKey;
          writeFileSync(SECRETS_PATH, JSON.stringify(sec, null, 2) + '\n');
          secrets = sec;
          // 明示操作は最終決定: config.json 残存の旧キーも消し、直後の移行で復活させない
          delete fresh.apiKey;
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
        // acpOptions はエンジン別マップをマージ。値 '' は削除（既定へ戻す）
        if (patch.acpOptions !== undefined) {
          const base = fresh.acpOptions &&
            !Object.values(fresh.acpOptions).some((v) => typeof v === 'string')
            ? fresh.acpOptions : { devin: fresh.acpOptions ?? {} };
          const merged = { ...base };
          for (const [e2, opts] of Object.entries(patch.acpOptions)) {
            const m = { ...(base[e2] ?? {}) };
            for (const [oid, v] of Object.entries(opts ?? {})) {
              if (v === '') delete m[oid]; else m[oid] = String(v);
            }
            merged[e2] = m;
          }
          fresh.acpOptions = merged;
          applied.acpOptions = patch.acpOptions;
          delete patch.acpOptions;
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
      if (url.pathname === '/api/chat/attach') {
        // チャット添付を chat-uploads/ へ保存し {files:[{name,path}]} を返す。
        // 送信本体は /api/chat/send・/api/steer 共通でテキスト中の
        // [添付] パス行をエージェントへ渡す（パネル側が付記する）
        const { attachments } =
          JSON.parse((await readBody(req, 25 * 1024 * 1024)) || '{}');
        try { return json(200, { ok: true, files: saveChatAttachments(attachments) }); }
        catch (e) { return json(400, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/chat/send') {
        const { id, text } = JSON.parse((await readBody(req)) || '{}');
        if (!text) return json(400, { ok: false, error: 'empty text' });
        // 手動チャットも engine 設定に従う（devin/copilot=ACPセッション、その他=単発shim）。
        // 既存セッション id が指定された場合はそのエンジンのまま継続する
        const eng = resolveEngine(null, 'chat', null, {}, {});
        const sid = id && chats.has(id) ? id : pickChatId('chat', eng);
        try { await chats.get(sid).chat.send(String(text)); return json(200, { ok: true, id: sid }); }
        catch (e) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/ai/chat') {
        // CANVAS AI タブ相当: OpenAI 互換 LLM + MCP_TOOLS ツール呼出ループ
        const { messages, maxSteps } = JSON.parse((await readBody(req)) || '{}');
        if (!Array.isArray(messages) || !messages.length)
          return json(400, { ok: false, error: 'messages required' });
        try { return json(200, await aiChat(messages, maxSteps)); }
        catch (e) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/chat/option') {
        const { sid, id, value } = JSON.parse((await readBody(req)) || '{}');
        try {
          const s0 = chats.get(sid);
          const eng = s0?.chat?.engine ?? 'devin';
          await s0.chat.setOption(id, value);
          // モデル/モード選択を config.acpOptions[engine] へ永続化（次回 session/new で再適用）
          const fresh = loadJson(CONFIG_PATH, config);
          const ao = fresh.acpOptions;
          fresh.acpOptions =
            ao && !Object.values(ao).some((v) => typeof v === 'string')
              ? ao : { devin: ao ?? {} };
          (fresh.acpOptions[eng] ??= {})[id] = value;
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
        if (s) {
          // close は session/close 通知付きの畳み込み（無ければ reset に相当）
          try { await (s.chat.close?.() ?? s.chat.reset()); } catch { /* noop */ }
          chats.delete(id);
          persistChats();
        }
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
          // closed 課題に処理済み/実行中ラベルが残ると、検索インデックス反映まで
          // 再検証候補として残像が出るため併せて剥がす（失敗は無視）
          try {
            const lbls = candLabels();
            const cur2 = await ghJson(['issue', 'view', m[3], '-R', m[1], '--json', 'labels']);
            const have = new Set((cur2.labels ?? []).map((l) => l.name ?? l));
            for (const l of [lbls.implDone, lbls.running].filter((x) => have.has(x))) {
              await new Promise((res) => {
                execFile('gh', ['issue', 'edit', m[3], '-R', m[1],
                  '--remove-label', l], () => res());
              });
            }
          } catch { /* noop */ }
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
        if (provider === 'devin') {
          // devin.exe acp session/new の configOptions からモデル系を取り出す
          try {
            const opts = await devinConfigOptions();
            const mo = opts.find((o) => o && o.category === 'model') ||
              opts.find((o) => o && /model/i.test(String(o.id)));
            if (!mo) return json(502,
              { ok: false, error: 'configOptions にモデル選択がありません' });
            return json(200, { ok: true, optionId: mo.id,
              current: acpOptionsOf(config, 'devin')[mo.id] ?? mo.currentValue ?? '',
              models: (mo.options ?? [])
                .map((v) => ({ value: v.value, name: v.name ?? v.value })) });
          } catch (e) { return json(502, { ok: false, error: e.message }); }
        }
        const u = (config.apiUrl || '').replace(/\/+$/, '');
        if (!u) return json(400, { ok: false, error: 'apiUrl 未設定' });
        try {
          // apiProvider（openai/anthropic/azure）に応じた一覧 API を呼ぶ
          return json(200, { ok: true,
            models: await apiListModels(config, effectiveApiKey()) });
        } catch (e) { return json(502, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/bridge-install') {
        // bridge-hub.exe を CDN から取得して自己インストール（8511 常駐）を起動
        const url0 = 'https://yamamoto-ryuzo.github.io/kasugai-canvas-web/stable/download/bridge-hub.exe';
        const dst = join(ROOT, 'bridge-hub.exe');
        const r = await fetch(url0);
        if (!r.ok) return json(500, { ok: false, error: 'download ' + r.status });
        const buf = Buffer.from(await r.arrayBuffer());
        // CDN 改変・転送破損の検出: 配布 repo の git blob sha と別経路で照合
        const meta = await fetch('https://api.github.com/repos/yamamoto-ryuzo/kasugai-canvas-web/contents/stable/download/bridge-hub.exe',
          { headers: { 'User-Agent': 'devin-issue-dispatcher' } });
        const mj = await meta.json().catch(() => null);
        if (!meta.ok || typeof mj?.sha !== 'string') {
          return json(502, { ok: false, error: 'checksum fetch ' + meta.status });
        }
        const blobSha = createHash('sha1')
          .update(`blob ${buf.length}\0`).update(buf).digest('hex');
        if (blobSha !== mj.sha) return json(502, { ok: false, error: 'checksum mismatch' });
        writeFileSync(dst, buf);
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
        // 課題整理タブの貼り付け画像をアセットブランチへ格納しリンクを返す
        // （ISSUE 登録の添付と同じ issueAssetLinks 経路に統一）
        const { data, repo } = JSON.parse((await readBody(req, 25 * 1024 * 1024)) || '{}');
        if (!config.repos?.some((r) => r.github === repo)) {
          return json(400, { ok: false, error: 'repo not monitored: ' + repo });
        }
        try {
          const links = await issueAssetLinks(repo, [{ name: 'shot', data }]);
          return json(200, { ok: true, link: links[0] });
        } catch (e) { return json(500, { ok: false, error: e.message }); }
      }
      if (url.pathname === '/api/issue') {
        // 課題整理タブからの Issue 起票（監視リポジトリ限定）
        const { repo, title, body, attachments } =
          JSON.parse((await readBody(req, 25 * 1024 * 1024)) || '{}');
        if (!config.repos?.some((r) => r.github === repo)) {
          return json(400, { ok: false, error: 'repo not monitored: ' + repo });
        }
        if (!title) return json(400, { ok: false, error: 'empty title' });
        // 二重起票防止: 同一タイトルの open Issue が既にあれば作成せず既存を返す
        const dup = Object.values(readIssueStore(ISSUES_PATH).issues ?? {})
          .find((it) => it.repo === repo && it.type === 'issue' && it.title === title);
        if (dup) return json(200, { ok: true, url: dup.url, dup: true });
        try {
          let bodyText = String(body ?? '');
          if (Array.isArray(attachments) && attachments.length) {
            bodyText += (bodyText.trim() ? '\n\n' : '') +
              (await issueAssetLinks(repo, attachments)).join('\n');
          }
          const out = await new Promise((res2, rej) => {
            execFile('gh', ['issue', 'create', '-R', repo,
              '--title', title, '--body', bodyText],
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
            markQueued(key, mode);
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
        if (eng && eng !== 'devin') {
          return json(400, { ok: false,
            error: 'engine "' + eng + '" はキュー経路では指定不可（MCP 消費側は devin 固定）' });
        }
        // 解決エンジン（課題/設定側の指定含む）が api の課題は評価専用。impl 登録を抑止
        if (!isAssess && resolveEngine(key, 'impl', eng) === 'api') {
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
    if (url.pathname === '/api/events') {
      // SSE: state.json 等の変化を push。GET かつ読み取り専用なので X-Panel 不要
      // （EventSource はカスタムヘッダを送れないため POST 系の CSRF 措置とは別経路）
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(acao ? { 'Access-Control-Allow-Origin': acao } : {}),
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      ensureStateWatcher();
      // アイドル切断対策のハートビート（コメント行 = イベント扱いされない）
      const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch { /* noop */ } }, 25000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
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
      const idRaw = url.searchParams.get('id');
      const id = idRaw != null && /^\d+$/.test(idRaw) ? +idRaw : idRaw;
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
        enabled: skillEnabled(config, f),
        content: (() => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } })(),
      }));
      // plugins: 種別付き拡張レジストリ（'skill' 以外の将来拡張種別も含め公開）
      return json(200, { files, plugins: config.plugins ?? [] });
    }
    if (url.pathname === '/api/prompts') {
      // prompts/ の *.md を読み取り専用一覧（リポジトリ指針のプレビュー用。
      // 書き込み経路は持たない。taskPrompt/loadPolicy が使う正本そのものを返す）
      const dir = join(ROOT, 'prompts');
      let files = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
          .map((f) => ({ name: f, content: readFileSync(join(dir, f), 'utf8') }));
      } catch { /* noop */ }
      return json(200, { files });
    }
    if (url.pathname === '/api/metrics') {
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '7', 10) || 7, 1), 365);
      return json(200, { ok: true, ...computeMetrics(loadJson(STATE_PATH, { tasks: {} }), days) });
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

// control 再起動で消えた委譲 watcher の再武装。implWatchers はメモリ内のため
// 再起動すると chatDelegated が残った課題が孤立し、dispatcher が
// "delegated chat run in flight" で永久スキップする。復元チャットは
// busy=false 固定（send しない限り busy に戻らない）のため、busy が立っている
// 場合のみ watchImpl を再アームし、それ以外は stall 窓（chatStallMinutes）の
// 残時間だけ孤児ターンの書込みを待ってから gh 実状態で終端解決する
function resumeDelegatedWatches() {
  const st = loadJson(STATE_PATH, { tasks: {} });
  const stallMs = Math.max(+(config.chatStallMinutes ?? 30), 1) * 60 * 1000;
  for (const [key, t] of Object.entries(st.tasks ?? {})) {
    if (!t?.chatDelegated || t.chatResult) continue;
    const ch = t.chatId != null ? chats.get(t.chatId)?.chat : null;
    if (ch?.busy) { watchImpl(key, ch); continue; }
    const wait = isDelegatedStale(t, { staleMs: stallMs }) ? 0
      : Math.max(0, new Date(t.delegatedAt ?? 0).getTime() + stallMs - Date.now());
    setTimeout(() => resolveDelegatedEnd(key, 'startup-sweep')
      .catch(() => {}), wait).unref?.();
  }
}

server.listen(PORT, HOST, () => {
  // dispatcher は常駐前提で自動起動（各自動化はトグルフラグで制御）
  {
    const r = startDispatcher('loop');
    console.log(`[control] auto-started dispatcher: ${JSON.stringify(r)}`);
  }
  resumeDelegatedWatches();
  console.log(`[control] panel: http://${HOST}:${PORT}/`);
});

process.on('SIGINT', () => { child?.proc.kill(); process.exit(0); });
