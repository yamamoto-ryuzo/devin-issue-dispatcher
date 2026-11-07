#!/usr/bin/env node
/**
 * ACP セッションランナー（プロトタイプ）
 *
 * `devin acp`（Agent Client Protocol / JSON-RPC over stdio）に接続して
 * 1セッションを実行する。`devin -p` と違い、実行中に steer-requests.json 経由で
 * 追加入力（指示の見直し・追加制約）を送れる。
 *
 * 使い方: node acp-runner.mjs <key> <promptFile>
 *   key = "owner/repo issue#N"（kill/steer のマッチング用）
 *   promptFile = プロンプト本文ファイル
 *   ログ: logs/<key>_<ts>_acp.log（session/update 通知を転記）
 *   steer: steer-requests.json に {key, text} を書き込むと session/prompt で送信
 *   stop : kill-requests.json に key を書き込むとセッションを終了
 */
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const [key, promptFile] = process.argv.slice(2);
if (!key || !promptFile) { console.error('usage: acp-runner.mjs <key> <promptFile>'); process.exit(1); }

const safe = key.replace('/', '_').replace(/[#\s]/g, '');
const LOG = join(ROOT, 'logs', `${safe}_acp_${Date.now()}.log`);
const out = (s) => { appendFileSync(LOG, s + '\n'); };
const repo = (config.repos ?? []).find((r) => r.github === key.split(' ')[0]);

const proc = spawn(config.devinExe, ['acp'], {
  cwd: repo?.path ?? ROOT,
  stdio: ['pipe', 'pipe', 'inherit'],
});
let seq = 0;
const pending = new Map();
const rpc = (method, params) => {
  const id = ++seq;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
const notify = (method, params) =>
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

let sessionId = null;
let buf = '';
proc.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    } else if (msg.method === 'session/update') {
      // エージェントの出力・ツール活動をログへ転記（パネルの tasklog で追える）
      out(JSON.stringify(msg.params));
    } else if (msg.method === 'session/request_permission' && msg.id != null) {
      // 権限要求: config.verbosity 的には自動拒否しない方が安全だが、
      // 無人運用を前提に許可を返す（permissionMode=dangerous の場合は来ない）
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      }) + '\n');
    }
  }
});

// steer/kill 監視（2秒）
const STEER = join(ROOT, 'steer-requests.json');
const KILL = join(ROOT, 'kill-requests.json');
const iv = setInterval(async () => {
  try {
    if (sessionId) {
      const s = existsSync(STEER) ? JSON.parse(readFileSync(STEER, 'utf8')) : { items: [] };
      const mine = (s.items ?? []).filter((x) => x.key === key);
      if (mine.length) {
        s.items = s.items.filter((x) => x.key !== key);
        writeFileSync(STEER, JSON.stringify(s));
        for (const it of mine) {
          out(`[steer] ${it.text}`);
          await rpc('session/prompt', {
            sessionId, prompt: [{ type: 'text', text: it.text }],
          }).catch((e) => out(`[steer error] ${e.message}`));
        }
      }
    }
    const k = existsSync(KILL) ? JSON.parse(readFileSync(KILL, 'utf8')) : { keys: [] };
    if ((k.keys ?? []).includes(key)) {
      k.keys = k.keys.filter((x) => x !== key);
      writeFileSync(KILL, JSON.stringify(k));
      out('[stopped by user]');
      proc.kill();
      clearInterval(iv);
    }
  } catch { /* noop */ }
}, 2000);

proc.on('close', (c) => { clearInterval(iv); out(`[session closed exit=${c}]`); process.exit(c ?? 0); });
proc.on('error', (e) => { out(`[spawn error] ${e.message}`); process.exit(1); });

(async () => {
  try {
    await rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    const s = await rpc('session/new', {
      cwd: repo?.path ?? ROOT, mcpServers: [],
    });
    sessionId = s.sessionId;
    out(`[session started] ${sessionId} key=${key}`);
    const res = await rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: readFileSync(promptFile, 'utf8') }],
    });
    out(`[done] ${JSON.stringify(res ?? {})}`);
    proc.kill();
  } catch (e) {
    out(`[fatal] ${e.message}`);
    proc.kill();
    process.exit(1);
  }
})();
