// Devin ACP チャット管理（control.mjs から利用）
// devin.exe acp を常駐 spawn し、session/new で1セッションを維持。
// 送受信を messages 配列に蓄積する（パネルはこれを表示）。
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export class AcpChat {
  constructor({ devinExe, cwd }) {
    this.devinExe = devinExe;
    this.cwd = cwd;
    this.proc = null;
    this.sessionId = null;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
    this.messages = []; // {role:'user'|'agent'|'tool'|'sys', text, ts, done?}
    this.busy = false;
    this.ready = false;
    this.error = null;
    const creds = readFileSync(join(homedir(), 'AppData/Roaming/devin/credentials.toml'), 'utf8');
    this.apiKey = creds.match(/windsurf_api_key\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
  }

  rpc(method, params) {
    const id = ++this.seq;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }

  push(role, text) {
    this.messages.push({ role, text, ts: new Date().toISOString() });
    if (this.messages.length > 500) this.messages = this.messages.slice(-400);
  }

  agentText(t) {
    const last = this.messages.at(-1);
    if (last?.role === 'agent' && !last.done) last.text += t;
    else this.messages.push({ role: 'agent', text: t, ts: new Date().toISOString() });
  }

  ensureProc() {
    if (this.proc) return;
    this.proc = spawn(this.devinExe, ['acp'], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        } else if (m.method === 'session/update') {
          this.onUpdate(m.params?.update);
        } else if (m.method === 'session/request_permission' && m.id != null) {
          const opt = m.params?.options?.[0]?.optionId ?? 'allow_once';
          this.proc.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: m.id,
            result: { outcome: { outcome: 'selected', optionId: opt } },
          }) + '\n');
        }
      }
    });
    this.proc.on('close', () => {
      this.push('sys', '[セッション切断]');
      this.proc = null; this.sessionId = null; this.ready = false; this.busy = false;
    });
    this.proc.on('error', (e) => { this.error = e.message; });
  }

  onUpdate(u) {
    if (!u) return;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
      this.agentText(u.content.text);
    } else if (u.sessionUpdate === 'tool_call') {
      const title = u.title ?? 'tool';
      this.push('tool', `${title}: ${JSON.stringify(u.rawInput ?? '').slice(0, 120)}`);
    } else if (u.sessionUpdate === 'turn_complete') {
      this.busy = false;
      const last = this.messages.at(-1);
      if (last?.role === 'agent') last.done = true;
    } else if (u.sessionUpdate === 'config_option_update' && u.configOptions) {
      this.options = u.configOptions;
    }
  }

  async ensureSession() {
    this.ensureProc();
    if (this.sessionId) return;
    if (!this.apiKey) throw new Error('windsurf_api_key not found');
    await this.rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    });
    await this.rpc('authenticate', { methodId: 'devin-browser', _meta: { api_key: this.apiKey } });
    const s = await this.rpc('session/new', { cwd: this.cwd, mcpServers: [] });
    this.sessionId = s.sessionId;
    this.ready = true;
    // Canvas AIチャット風: モデル/モード選択肢を保持（config_option_update で更新）
    this.options = s.configOptions ?? [];
    this.modes = s.modes ?? null;
    this.push('sys', `セッション開始 (${s.sessionId})`);
  }

  async send(text) {
    await this.ensureSession();
    this.push('user', text);
    this.busy = true;
    // 応答は session/update で流れる。prompt の完了は待たない（UIは busy で追跡）
    this.rpc('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }).then(() => { this.busy = false; })
      .catch((e) => { this.busy = false; this.push('sys', `[error] ${e.message}`); });
  }

  async setOption(id, value) {
    await this.ensureSession();
    const res = await this.rpc('session/set_config_option',
      { sessionId: this.sessionId, configId: id, value });
    this.push('sys', `${id} → ${value}`);
    return res;
  }

  async reset() {
    try { this.proc?.kill(); } catch { /* noop */ }
    this.proc = null; this.sessionId = null; this.ready = false;
    this.push('sys', 'セッションをリセットしました');
  }

  snapshot() {
    return {
      ready: this.ready, busy: this.busy, error: this.error,
      sessionId: this.sessionId, messages: this.messages,
      options: this.options ?? [], modes: this.modes,
    };
  }
}
