#!/usr/bin/env node
/**
 * ACP セッションランナー（devin.exe acp 経由の実行エンジン）
 *
 * 使い方: node acp-runner.mjs <key> <promptFile> <logFile>
 *   key        = "owner/repo issue#N"（kill/steer のマッチング用）
 *   promptFile = プロンプト本文ファイル
 *   logFile    = セッションログ（session/update の本文を転記。判定JSONもここから読む）
 *
 * 認証: %APPDATA%/devin/credentials.toml の windsurf_api_key を
 *       `authenticate` メソッドに渡す（IDE 認証の共有。表示・記録しない）
 * steer: steer-requests.json の {key,text} を session/prompt で追加入力
 * stop : kill-requests.json に key を書き込むと終了
 */
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mcpServersForSession } from './engine.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const [key, promptFile, logFile] = process.argv.slice(2);
if (!key || !promptFile || !logFile) {
  console.error('usage: acp-runner.mjs <key> <promptFile> <logFile>');
  process.exit(1);
}
const LOG = logFile;
const out = (s) => { appendFileSync(LOG, s + '\n'); };

// IDE 認証情報（表示しない）
const creds = readFileSync(join(homedir(), 'AppData/Roaming/devin/credentials.toml'), 'utf8');
const API_KEY = creds.match(/windsurf_api_key\s*=\s*['"]([^'"]+)['"]/)?.[1];
if (!API_KEY) { out('[auth] windsurf_api_key not found in credentials.toml'); process.exit(1); }

const repo = (config.repos ?? []).find((r) => r.github === key.split(' ')[0]);
// 過去のセッション由来の stale な kill 要求が残っていたら除去（新セッション開始時に即死しない）
{
  const k = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'kill-requests.json'), 'utf8')); } catch { return { keys: [] }; } })();
  if ((k.keys ?? []).includes(key)) {
    k.keys = k.keys.filter((x) => x !== key);
    writeFileSync(join(ROOT, 'kill-requests.json'), JSON.stringify(k));
  }
}
const acpArgs = ['acp', ...(config.devinExtraArgs ?? [])];
if (acpArgs.length > 1) console.error('acp spawn extra args: ' + acpArgs.slice(1).join(' '));
const proc = spawn(config.devinExe, acpArgs, {
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
      // チャット風の可読ストリームに整形（エージェント本文・ツール実行・計画）
      const u = msg.params?.update;
      if (!u) { /* noop */ }
      else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
        appendFileSync(LOG, u.content.text);
      } else if (u.sessionUpdate === 'tool_call') {
        const args = JSON.stringify(u.rawInput ?? u.input ?? '').slice(0, 160);
        out(`\n[tool →] ${u.title ?? u.toolName ?? 'tool'} ${args}`);
      } else if (u.sessionUpdate === 'tool_call_update' && u.status === 'failed') {
        out(`[tool ✗] ${u.title ?? ''}`);
      } else if (u.sessionUpdate === 'plan') {
        out(`[plan] ${JSON.stringify(u.entries ?? '').slice(0, 300)}`);
      }
      // agent_thought_chunk / config_option_update 等は省略
    } else if (msg.method === 'session/request_permission' && msg.id != null) {
      const option = config.permissionMode === 'dangerous' ? 'allow_always' : 'allow_once';
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { outcome: { outcome: 'selected', optionId: msg.params?.options?.[0]?.optionId ?? option } },
      }) + '\n');
    }
  }
});

// steer/kill 監視（2秒）
const STEER = join(ROOT, 'steer-requests.json');
const KILL = join(ROOT, 'kill-requests.json');
const loadJ = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const iv = setInterval(async () => {
  try {
    if (sessionId) {
      const s = loadJ(STEER, { items: [] });
      const mine = (s.items ?? []).filter((x) => x.key === key);
      if (mine.length) {
        s.items = s.items.filter((x) => x.key !== key);
        writeFileSync(STEER, JSON.stringify(s));
        for (const it of mine) {
          out(`\n[steer] ${it.text}\n`);
          rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: it.text }] })
            .catch((e) => out(`[steer error] ${e.message}`));
        }
      }
    }
    const k = loadJ(KILL, { keys: [] });
    if ((k.keys ?? []).includes(key)) {
      k.keys = k.keys.filter((x) => x !== key);
      writeFileSync(KILL, JSON.stringify(k));
      out('\n[stopped by user]');
      proc.kill();
    }
  } catch { /* noop */ }
}, 2000);

const finish = (code) => { clearInterval(iv); out(`\n[session closed exit=${code}]`); process.exit(code ?? 0); };
// 孫プロセスが stdio を握り続けると 'close' は発火しない（孤児化した検証
// サーバ・ブラウザ等で dispatcher 全体が永久待機した実績）。セッション終了
// ＝プロセス本体の 'exit' とし、'close' は保険として併用する
proc.on('exit', (c) => finish(c));
proc.on('close', (c) => finish(c));
proc.on('error', (e) => { out(`[spawn error] ${e.message}`); finish(1); });

(async () => {
  try {
    await rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    await rpc('authenticate', { methodId: 'devin-browser', _meta: { api_key: API_KEY } });
    // 内蔵 issue-queue（mcp-server.mjs）＋ config.mcpServers を渡す。
    // 不正エントリは警告してスキップし、session/new を失敗させない
    const mcpServers = (existsSync(join(ROOT, 'mcp-server.mjs'))
      ? [{ name: 'issue-queue', command: process.execPath,
          args: [join(ROOT, 'mcp-server.mjs')], env: [] }] : [])
      .concat(mcpServersForSession(config,
        loadJ(join(ROOT, 'secrets.json'), {}), (w) => out('[mcp] ' + w)));
    const s = await rpc('session/new', { cwd: repo?.path ?? ROOT, mcpServers });
    sessionId = s.sessionId;
    out(`[session started] ${sessionId} key=${key}`);
    // 永続化したモデル/モード選択を再適用（config.acpOptions.devin）
    {
      const ao = config.acpOptions;
      const opts = ao && Object.values(ao).some((v) => typeof v === 'string')
        ? ao : (ao?.devin ?? {});
      for (const [oid, v] of Object.entries(opts)) {
        try {
          await rpc('session/set_config_option',
            { sessionId, configId: oid, value: v });
          out(`[option] ${oid} -> ${v}`);
        } catch (e) { out(`[option失敗] ${oid}: ${e.message}`); }
      }
    }
    const res = await rpc('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: readFileSync(promptFile, 'utf8') }],
    });
    out(`\n[done] ${JSON.stringify(res ?? {})}`);
    finish(0);
  } catch (e) {
    out(`[fatal] ${e.message}`);
    finish(1);
  }
})();
