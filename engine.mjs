// エンジン送信・プロンプト注入・判定ブロック解析の共有コア。
// control.mjs の engineSend/dispatchChatTask/watchAssess/watchImpl が委譲する
// 単体import可能な純粋ロジック（node:test でモック検証するため切り出し）。

// apiUrl は Bearer キーを送信するため、外部ホストは https 限定。
// http は loopback/LAN（プライベートアドレス）のみ許可
export function isPrivateHost(hostname) {
  const h = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]); const b = Number(m[2]);
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function assertApiUrlSafe(raw) {
  const u = new URL(raw);
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:' && isPrivateHost(u.hostname)) return;
  throw new Error('apiUrl は外部ホストへ https のみ許可（http は loopback/LAN 限定）: ' + raw);
}

// api エンジンのプロバイダ別アダプタ（cfg.apiProvider で選択・既定 openai）。
// 非 OpenAI 互換 API の URL・認証ヘッダ・ボディ・応答形状の差異をここに集約する
// openai:    {apiUrl}/chat/completions + Bearer + /models
// anthropic: {apiUrl}/messages + x-api-key + anthropic-version + max_tokens 必須。
//            応答 content[].text 連結。一覧は /models（同ヘッダ）
// azure:     apiUrl=リソースベース URL・apiModel=デプロイメント名。
//            /openai/deployments/{model}/chat/completions?api-version= + api-key
const API_ADAPTERS = {
  openai: {
    chatUrl: (u) => u + '/chat/completions',
    modelsUrl: (u) => u + '/models',
    headers: (key) => (key ? { Authorization: 'Bearer ' + key } : {}),
    body: (cfg, prompt) => ({ model: cfg.apiModel,
      messages: [{ role: 'user', content: prompt }] }),
    reply: (j) => j?.choices?.[0]?.message?.content || '',
    models: (j) => (j?.data ?? []).map((m) => m.id).filter(Boolean),
    error: (j) => j?.error?.message,
  },
  anthropic: {
    chatUrl: (u) => u + '/messages',
    modelsUrl: (u) => u + '/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    body: (cfg, prompt) => ({ model: cfg.apiModel, max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }] }),
    reply: (j) => (j?.content ?? [])
      .map((b) => (b?.type === 'text' ? b.text : '') || '').join(''),
    models: (j) => (j?.data ?? []).map((m) => m.id ?? m.name).filter(Boolean),
    error: (j) => j?.error?.message,
  },
  azure: {
    chatUrl: (u, cfg) => u + '/openai/deployments/' +
      encodeURIComponent(cfg.apiModel) + '/chat/completions?api-version=' +
      encodeURIComponent(cfg.apiVersion ?? '2024-10-21'),
    modelsUrl: (u, cfg) => u + '/openai/models?api-version=' +
      encodeURIComponent(cfg.apiVersion ?? '2024-10-21'),
    headers: (key) => (key ? { 'api-key': key } : {}),
    body: (cfg, prompt) => ({ messages: [{ role: 'user', content: prompt }] }),
    reply: (j) => j?.choices?.[0]?.message?.content || '',
    models: (j) => (j?.data ?? []).map((m) => m.id).filter(Boolean),
    error: (j) => j?.error?.message,
  },
};
export const API_PROVIDER_NAMES = Object.keys(API_ADAPTERS);
export function apiAdapter(cfg) {
  return API_ADAPTERS[String(cfg?.apiProvider ?? 'openai').toLowerCase()]
    ?? API_ADAPTERS.openai;
}
// モデル一覧取得（プロバイダ別。対応しない一覧 API を持たない
// プロバイダは呼出側で手入力フォールバックとして扱う）
export async function apiListModels(cfg, apiKey) {
  const url = (cfg.apiUrl || '').replace(/\/+$/, '');
  if (!url) throw new Error('apiUrl 未設定');
  assertApiUrlSafe(url);
  const ad = apiAdapter(cfg);
  const r = await fetch(ad.modelsUrl(url, cfg),
    { redirect: 'manual', headers: ad.headers(apiKey) });
  if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
    throw new Error('models 取得のリダイレクトは未対応（https 直結のみ許可）');
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(ad.error(j) || 'models ' + r.status);
  return ad.models(j);
}

// cfg: {apiUrl, apiModel, apiProvider, apiVersion, bridgeHub, bridgeModels}
// bridgeToken: ハブ側がプロバイダ別 Bearer（COPILOT_BRIDGE_TOKEN 等）を
// 設定している場合の Authorization: Bearer 値（未設定なら無認証で送信）
export async function engineSendCore(cfg, apiKey, eng, prompt, bridgeToken = '') {
  if (eng === 'api') {
    const url = (cfg.apiUrl || '').replace(/\/+$/, '');
    if (!url || !cfg.apiModel) throw new Error('apiUrl/apiModel 未設定');
    assertApiUrlSafe(url);
    const ad = apiAdapter(cfg);
    const r = await fetch(ad.chatUrl(url, cfg), {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', ...ad.headers(apiKey) },
      body: JSON.stringify(ad.body(cfg, prompt)),
    });
    // キーがリダイレクト先へ漏れないよう自動追跡しない（aiChat と同じ方針）
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) {
      throw new Error('api リダイレクトは拒否されます（https 直結のみ許可）');
    }
    const j = await r.json();
    if (!r.ok) throw new Error(ad.error(j) || 'api ' + r.status);
    return ad.reply(j);
  }
  const hub = (cfg.bridgeHub || 'http://127.0.0.1:8511').replace(/\/+$/, '');
  // bridge-hub POST /agent 仕様: 本文は {provider, message, project, model,
  // history, ...}。プロンプトは message キーで送る（prompt は読まれない）。
  // 応答は {reply, actions}。actions はブラウザ実行用の地図操作ツールキューで
  // dispatcher は実行主体を持たないため無視し、reply のみを使う。
  const r = await fetch(hub + '/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      ...(bridgeToken ? { Authorization: 'Bearer ' + bridgeToken } : {}) },
    body: JSON.stringify({ provider: eng, message: prompt,
      project: 'agent-dispatcher',
      ...(cfg.bridgeModels?.[eng] ? { model: cfg.bridgeModels[eng] } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error || 'bridge-hub ' + r.status) +
    (r.status === 401 ? '（ハブ側で *_BRIDGE_TOKEN が設定済み。secrets.json の bridgeTokens.<provider> へ同じ値を設定してください）' : ''));
  return j.reply || j.text || '';
}

// dispatchChatTask の 【追加指示】注入を共有化
export function injectExtraPrompt(text, extraPrompt) {
  return text && extraPrompt ? text + '\n\n【追加指示】\n' + extraPrompt : text;
}

// 判定・切り分けブロック抽出（watchAssess/watchSplit と同一正規表現）
export const ASSESS_RE = /<!--devin-assess\s*([\s\S]*?)devin-assess-->/;
export const SPLIT_RE = /<!--split\s*([\s\S]*?)split-->/;

// プラグインレジストリ: cfg.plugins = [{type, name, enabled}]
// type:'skill' は skills/*.md のプロンプト注入を制御（未登録=有効扱い）。
// 'skill' 以外の type（'mcp'/'hook' 等）は将来の拡張種別用の登録枠
export function skillEnabled(cfg, name) {
  return (cfg?.plugins ?? [])
    .find((e) => e && e.type === 'skill' && e.name === name)?.enabled !== false;
}

// config.mcpServers を ACP session/new の mcpServers 形式へ正規化する。
// stdio 型 {name,command,args?,env?} / http・sse 型 {name,type?,url,headers?} を受理。
// env/headers の値は "${env:VAR}"（環境変数）・"${secrets:KEY}"
// （secrets.mcpTokens[KEY] に置く秘密情報の参照）を解決するため、
// トークンを config.json へ直接書かずに済む（シークレット分離ルール）。
// 形状不正なエントリは warn() で通知してスキップ（session/new を失敗させない）
export function mcpServersForSession(cfg, secrets = {}, warn = () => {}) {
  const kv = (o) => Object.fromEntries(
    Object.entries(o && typeof o === 'object' ? o : {})
      .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
      .map(([k, v]) => [k, v
        .replace(/^\$\{env:([\w]+)\}$/, (m, n) => process.env[n] ?? m)
        .replace(/^\$\{secrets:([\w.-]+)\}$/, (m, n) => secrets?.mcpTokens?.[n] ?? m)]));
  const out = [];
  for (const e of cfg?.mcpServers ?? []) {
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    if (!name) { warn('MCP エントリ: name 未設定のためスキップ'); continue; }
    if (typeof e.command === 'string' && e.command) {
      out.push({ name, command: e.command,
        args: Array.isArray(e.args) ? e.args.map(String) : [], env: kv(e.env) });
    } else if (typeof e.url === 'string' && e.url) {
      out.push({ name, type: e.type === 'sse' ? 'sse' : 'http',
        url: e.url, headers: kv(e.headers) });
    } else warn(`MCP エントリ "${name}": command/url 未設定のためスキップ`);
  }
  return out;
}
