// ACP session/new の mcpServers 形状が devin.exe に受理されるかの検証プローブ。
// initialize → authenticate → session/new まで行い、prompt は送らずに終了する。
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mcpServersForSession } from '../engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const creds = readFileSync(join(homedir(), 'AppData/Roaming/devin/credentials.toml'), 'utf8');
const API_KEY = creds.match(/windsurf_api_key\s*=\s*['"]([^'"]+)['"]/)?.[1];
if (!API_KEY) { console.error('no api key'); process.exit(1); }

const proc = spawn(config.devinExe, ['acp'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
let seq = 0;
const pending = new Map();
const rpc = (method, params) => {
  const id = ++seq;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
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
    }
  }
});
const timeout = setTimeout(() => { console.error('TIMEOUT'); proc.kill(); process.exit(2); }, 60000);
try {
  await rpc('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  await rpc('authenticate', { methodId: 'devin-browser', _meta: { api_key: API_KEY } });
  const mcpServers = (existsSync(join(ROOT, 'mcp-server.mjs'))
    ? [{ name: 'issue-queue', command: process.execPath,
        args: [join(ROOT, 'mcp-server.mjs')], env: [] }] : [])
    .concat(mcpServersForSession(config, {}, (w) => console.log('[mcp]', w)));
  console.log('mcpServers =', JSON.stringify(mcpServers));
  const s = await rpc('session/new', { cwd: ROOT, mcpServers });
  console.log('SESSION_OK', s.sessionId);
  proc.kill();
  clearTimeout(timeout);
  process.exit(0);
} catch (e) {
  console.error('FAILED:', e.message);
  proc.kill();
  clearTimeout(timeout);
  process.exit(1);
}
