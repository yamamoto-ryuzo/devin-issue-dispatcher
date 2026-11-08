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

// cfg: {apiUrl, apiModel, bridgeHub, bridgeModels}
export async function engineSendCore(cfg, apiKey, eng, prompt) {
  if (eng === 'api') {
    const url = (cfg.apiUrl || '').replace(/\/+$/, '');
    if (!url || !cfg.apiModel) throw new Error('apiUrl/apiModel 未設定');
    assertApiUrlSafe(url);
    const r = await fetch(url + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
      body: JSON.stringify({ model: cfg.apiModel,
        messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || 'api ' + r.status);
    return j.choices?.[0]?.message?.content || '';
  }
  const hub = (cfg.bridgeHub || 'http://127.0.0.1:8511').replace(/\/+$/, '');
  const r = await fetch(hub + '/agent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: eng, prompt,
      ...(cfg.bridgeModels?.[eng] ? { model: cfg.bridgeModels[eng] } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'bridge-hub ' + r.status);
  return j.reply || j.text || '';
}

// dispatchChatTask の 【追加指示】注入を共有化
export function injectExtraPrompt(text, extraPrompt) {
  return text && extraPrompt ? text + '\n\n【追加指示】\n' + extraPrompt : text;
}

// 判定・PRブロック抽出（watchAssess/watchImpl と同一正規表現）
export const ASSESS_RE = /<!--devin-assess\s*([\s\S]*?)devin-assess-->/;
export const SPLIT_RE = /<!--split\s*([\s\S]*?)split-->/;
export const IMPLPR_RE = /<!--impl-pr\s*([\s\S]*?)impl-pr-->/;
export const PRURL_RE = /github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;
