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
import { readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, statSync, renameSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyOf, discover, toCandidate, readIssueStore } from './discover.mjs';

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
      maxNewPerPoll: config.maxNewPerPoll ?? 50,
      repos: (config.repos ?? []).map((r) => r.github),
    },
    tasks,
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
          'maxConcurrent', 'autoDiscover', 'autoTrigger', 'autoAssess',
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
      if (url.pathname === '/api/dispatch' || url.pathname === '/api/assess') {
        // 実行キュー登録: エンジンは Devin IDE 側エージェント（mcp-server.mjs 経由で受け取る）
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
