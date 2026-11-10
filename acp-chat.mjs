// ACP チャット管理（control.mjs から利用）
// engine='devin'   → devin.exe acp（windsurf_api_key で authenticate）
// engine='copilot' → copilot --acp --stdio（認証は CLI 側の gh ログインに委譲）
// session/new で1セッションを維持し、送受信を messages 配列に蓄積する
// （パネルはこれを表示）。
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// copilot CLI の spawn 指定を解決（kasugai_canvas bridge の探索順に準拠）
// 返り値: {command, args}。.cmd shim は cmd /c 経由にする
function copilotSpawnSpec() {
  const wrap = (cmd, args, verbatim) => ({ command: cmd, args, verbatim });
  const exe = (p) => wrap(p, ['--acp', '--stdio'], false);
  // .cmd shim は cmd /c 経由。/c 以降は cmd が生コマンド行として解釈するため
  // Node 側の引数エスケープを windowsVerbatimArguments で無効化し、
  // スペースを含むパスも ""path" args" 形式で渡せるようにする
  const cmdShim = (p) =>
    wrap('cmd.exe', ['/d', '/s', '/c', `""${p}" --acp --stdio"`], true);
  const env = process.env.COPILOT_CLI_PATH;
  if (env) return /\.(cmd|bat)$/i.test(env) ? cmdShim(env) : exe(env);
  try {
    // where は extensionless shim も返すため Windows 実行可能な拡張子を優先
    const p = execFileSync('where.exe', ['copilot'], { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim())
      .find((l) => /\.(exe|cmd|bat)$/i.test(l));
    if (p) return /\.(cmd|bat)$/i.test(p) ? cmdShim(p) : exe(p);
  } catch { /* PATH 未検出は次候補へ */ }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const shim = join(local, 'Microsoft', 'WinGet', 'Links', 'copilot.exe');
    if (existsSync(shim)) return exe(shim);
  }
  const appdata = process.env.APPDATA;
  if (appdata) {
    const shim = join(appdata, 'npm', 'copilot.cmd');
    if (existsSync(shim)) return cmdShim(shim);
  }
  // 最後の手段: PATH 解決任せ（cmd 経由で .cmd shim も拾える）
  return wrap('cmd.exe', ['/d', '/s', '/c', 'copilot --acp --stdio'], true);
}

export class AcpChat {
  constructor({ engine, devinExe, cwd, getPersistedOptions, saveOption, getMcpServers,
                initialSessionId, onSessionId }) {
    this.engine = engine ?? 'devin';
    this.devinExe = devinExe;
    this.cwd = cwd;
    this.getPersistedOptions = getPersistedOptions ?? (() => ({}));
    this.saveOption = saveOption ?? (() => {});
    // session/new の mcpServers を都度解決する（config 変更を新セッションへ反映）
    this.getMcpServers = getMcpServers ?? (() => []);
    // 切断・再起動後に ACP session/load で再開するための永続化済み sessionId。
    // 変更時は onSessionId(id|null) で呼び出し側の永続化層へ通知する
    this.savedSessionId = initialSessionId ?? null;
    this.onSessionId = onSessionId ?? (() => {});
    this.agentCaps = null;
    this.proc = null;
    this.sessionId = null;
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
    this.messages = []; // {role:'user'|'agent'|'tool'|'sys', text, ts, done?}
    this.busy = false;
    this.ready = false;
    this.error = null;
    // devin 認証のみ使用。copilot では読まないが欠落時も構築は失敗させない
    try {
      const creds = readFileSync(join(homedir(), 'AppData/Roaming/devin/credentials.toml'), 'utf8');
      this.apiKey = creds.match(/windsurf_api_key\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    } catch { this.apiKey = null; }
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

  // session/load 時の履歴再送（user_message_chunk）を表示へ反映する
  userText(t) {
    const last = this.messages.at(-1);
    if (last?.role === 'user' && !last.done) last.text += t;
    else this.messages.push({ role: 'user', text: t, ts: new Date().toISOString() });
  }

  spawnSpec() {
    return this.engine === 'copilot'
      ? copilotSpawnSpec()
      : { command: this.devinExe, args: ['acp'] };
  }

  ensureProc() {
    if (this.proc) return;
    const spec = this.spawnSpec();
    this.proc = spawn(spec.command, spec.args, {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'inherit'],
      windowsVerbatimArguments: spec.verbatim ?? false,
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
          // allow 系を優先して自動許可（自律実行前提）
          const opts = m.params?.options ?? [];
          const opt = opts.find((o) => /always/i.test(String(o.optionId ?? '')))
            ?? opts.find((o) => /allow/i.test(String(o.optionId ?? o.name ?? '')))
            ?? opts[0];
          const optionId = opt?.optionId ?? 'allow_once';
          this.proc.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: m.id,
            result: { outcome: { outcome: 'selected', optionId } },
          }) + '\n');
        }
      }
    });
    this.proc.on('close', () => {
      this.push('sys', '[セッション切断]');
      // savedSessionId は残す（次の送信で session/load による再開を試みる）
      this.proc = null; this.sessionId = null; this.ready = false; this.busy = false;
    });
    this.proc.on('error', (e) => {
      this.error = e.message;
      // spawn 失敗時は滞留中の rpc を全て拒否（initialize が宙に浮かないように）
      for (const p of this.pending.values()) p.rej(e);
      this.pending.clear();
    });
  }

  onUpdate(u) {
    if (!u) return;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
      this.agentText(u.content.text);
    } else if (u.sessionUpdate === 'user_message_chunk' && u.content?.text) {
      this.userText(u.content.text);
    } else if (u.sessionUpdate === 'tool_call') {
      const title = u.title ?? 'tool';
      this.push('tool', `${title}: ${JSON.stringify(u.rawInput ?? '').slice(0, 120)}`);
    } else if (u.sessionUpdate === 'turn_complete') {
      this.busy = false;
      const last = this.messages.at(-1);
      if (last?.role === 'agent' || last?.role === 'user') last.done = true;
    } else if (u.sessionUpdate === 'config_option_update' && u.configOptions) {
      this.options = u.configOptions;
    }
  }

  async authenticate(init) {
    if (this.engine === 'devin') {
      if (!this.apiKey) throw new Error('windsurf_api_key not found');
      await this.rpc('authenticate', {
        methodId: 'devin-browser', _meta: { api_key: this.apiKey } });
      return;
    }
    // copilot: 認証は CLI 側の gh ログインに委譲。authMethods が
    // 提示された場合のみ先頭方式で authenticate を試みる
    const m = init?.authMethods?.[0];
    if (m?.id) await this.rpc('authenticate', { methodId: m.id });
  }

  async ensureSession() {
    this.ensureProc();
    if (this.sessionId) return;
    const init = await this.rpc('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'devin-agent-dispatcher', version: '1.0.0' },
      // terminal/fs を true にすると実行がホスト（=このクライアント）に委任され
      // 未実装のまま応答が返らずターンが停止する。エージェント側のツールに任せる。
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.agentCaps = init?.agentCapabilities ?? null;
    await this.authenticate(init);
    // 既存セッションの再開: 保持済み sessionId があってエージェントが
    // loadSession 対応なら session/load を試し、失敗・非対応時は新規へ
    if (this.savedSessionId && this.agentCaps?.loadSession) {
      try {
        const s = await this.rpc('session/load',
          { sessionId: this.savedSessionId, cwd: this.cwd,
            mcpServers: this.getMcpServers() });
        this.sessionId = this.savedSessionId;
        this.ready = true;
        this.options = s?.configOptions ?? this.options ?? [];
        this.modes = s?.modes ?? this.modes ?? null;
        this.push('sys', `セッション再開 [${this.engine}] (${this.sessionId})`);
        return;
      } catch (e) {
        this.push('sys', `[再開失敗] ${e.message} → 新規セッションを開始します`);
        this.savedSessionId = null;
        this.onSessionId(null);
      }
    }
    const s = await this.rpc('session/new',
      { cwd: this.cwd, mcpServers: this.getMcpServers() });
    this.sessionId = s.sessionId;
    this.savedSessionId = s.sessionId;
    this.onSessionId(s.sessionId);
    this.ready = true;
    // Canvas AIチャット風: モデル/モード選択肢を保持（config_option_update で更新）
    this.options = s.configOptions ?? [];
    this.modes = s.modes ?? null;
    this.push('sys', `セッション開始 [${this.engine}] (${s.sessionId})`);
    // 永続化したモデル/モード選択を新セッションへ再適用
    for (const [oid, v] of Object.entries(this.getPersistedOptions())) {
      try {
        await this.rpc('session/set_config_option',
          { sessionId: this.sessionId, configId: oid, value: v });
        this.push('sys', `[option復元] ${oid} → ${v}`);
      } catch (e) {
        this.push('sys', `[option復元失敗] ${oid}: ${e.message}`);
      }
    }
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
    this.saveOption(id, value);
    this.push('sys', `${id} → ${value}`);
    return res;
  }

  clear() {
    this.messages = [];
    this.push('sys', '履歴をクリアしました（セッションは継続中）');
  }

  async cancel() {
    if (!this.sessionId) return;
    try { await this.rpc('session/cancel', { sessionId: this.sessionId }); }
    catch { /* noop */ }
    this.busy = false;
    const last = this.messages.at(-1);
    if (last?.role === 'agent') last.done = true;
    this.push('sys', '[中断しました]');
  }

  async reset() {
    try { this.proc?.kill(); } catch { /* noop */ }
    this.proc = null; this.sessionId = null; this.ready = false;
    if (this.savedSessionId) {
      this.savedSessionId = null;
      this.onSessionId(null);
    }
    this.push('sys', 'セッションをリセットしました');
  }

  // セッションを閉じる（パネル「✕」）。devin 側のセッション一覧を掃除するため
  // session/close を best-effort で通知してからローカルを畳む
  async close() {
    if (this.proc && this.sessionId && this.agentCaps?.sessionCapabilities?.close) {
      try {
        await Promise.race([
          this.rpc('session/close', { sessionId: this.sessionId }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
        ]);
      } catch { /* noop */ }
    }
    await this.reset();
  }

  snapshot() {
    return {
      ready: this.ready, busy: this.busy, error: this.error,
      live: !!this.proc,
      // sessionId 未接続でも savedSessionId があれば再開可能として返す
      sessionId: this.sessionId ?? this.savedSessionId,
      resumable: !this.proc && !!this.savedSessionId,
      messages: this.messages,
      options: this.options ?? [], modes: this.modes,
    };
  }
}
