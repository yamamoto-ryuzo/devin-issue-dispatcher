import test from 'node:test';
import assert from 'node:assert/strict';
import { engineSendCore, injectExtraPrompt, assertApiUrlSafe,
         skillEnabled, mcpServersForSession, ASSESS_RE, SPLIT_RE } from '../engine.mjs';

const mockFetch = (fn) => { const orig = globalThis.fetch; globalThis.fetch = fn; return () => { globalThis.fetch = orig; }; };
const res = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('engineSend api: headers/body と choices[0].message.content', async () => {
  let got;
  const un = mockFetch(async (url, init) => { got = { url, init }; return res({ choices: [{ message: { content: 'OK' } }] }); });
  const out = await engineSendCore({ apiUrl: 'https://api.example.com/v1/', apiModel: 'm1' }, 'KEY', 'api', 'hi');
  un();
  assert.equal(out, 'OK');
  assert.equal(got.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(got.init.headers.Authorization, 'Bearer KEY');
  const body = JSON.parse(got.init.body);
  assert.equal(body.model, 'm1');
  assert.equal(body.messages[0].content, 'hi');
});

test('engineSend api: 外部 http は拒否・未設定はエラー', async () => {
  await assert.rejects(() => engineSendCore({ apiUrl: 'http://evil.example.com', apiModel: 'm' }, '', 'api', 'x'), /https のみ許可/);
  await assert.rejects(() => engineSendCore({ apiUrl: '', apiModel: 'm' }, '', 'api', 'x'), /未設定/);
});

test('engineSend copilot: bridge-hub /agent 仕様とエラー解釈', async () => {
  let got;
  const un = mockFetch(async (url, init) => { got = { url, init }; return res({ reply: 'RE' }); });
  const out = await engineSendCore({ bridgeHub: 'http://127.0.0.1:9999/', bridgeModels: { copilot: 'gpt-x' } }, '', 'copilot', 'p');
  un();
  assert.equal(out, 'RE');
  assert.equal(got.url, 'http://127.0.0.1:9999/agent');
  const body = JSON.parse(got.init.body);
  assert.deepEqual(body, { provider: 'copilot', message: 'p', project: 'agent-dispatcher', model: 'gpt-x' });
  const un2 = mockFetch(async () => res({ error: 'denied' }, false, 403));
  await assert.rejects(() => engineSendCore({}, '', 'copilot', 'p'), /denied/);
  un2();
  // bridgeToken 指定時は Authorization: Bearer を送る（ハブの *_BRIDGE_TOKEN 対応）
  const un3 = mockFetch(async (url, init) => { got = { url, init }; return res({ reply: 'OK' }); });
  await engineSendCore({}, '', 'copilot', 'p', 'TOK');
  un3();
  assert.equal(got.init.headers.Authorization, 'Bearer TOK');
  // 401 時はトークン設定のヒントを含む
  const un4 = mockFetch(async () => res({ error: 'unauthorized' }, false, 401));
  await assert.rejects(() => engineSendCore({}, '', 'copilot', 'p'), /bridgeTokens/);
  un4();
});

test('injectExtraPrompt: 付与の有無', () => {
  assert.equal(injectExtraPrompt('base', 'EXTRA'), 'base\n\n【追加指示】\nEXTRA');
  assert.equal(injectExtraPrompt('base', ''), 'base');
});

test('assertApiUrlSafe: https 許可・loopback http 許可・外部 http 拒否', () => {
  assert.doesNotThrow(() => assertApiUrlSafe('https://a.example.com'));
  assert.doesNotThrow(() => assertApiUrlSafe('http://127.0.0.1:11434'));
  assert.throws(() => assertApiUrlSafe('http://8.8.8.8'), /https のみ許可/);
});

test('skillEnabled: 未登録=有効・type=skill enabled:false で無効・他typeは無関係', () => {
  assert.equal(skillEnabled({}, '_all.md'), true);
  const cfg = { plugins: [
    { type: 'skill', name: '_done.md', enabled: false },
    { type: 'mcp', name: 'extra-server', enabled: true },
    { type: 'skill', name: '_impl.md', enabled: true }] };
  assert.equal(skillEnabled(cfg, '_done.md'), false);
  assert.equal(skillEnabled(cfg, '_all.md'), true);
  assert.equal(skillEnabled(cfg, 'extra-server'), true); // type!=skill は対象外
});

test('mcpServersForSession: stdio/http 正規化・不正スキップ・参照解決', () => {
  const warns = [];
  const cfg = { mcpServers: [
    { name: 'fs', command: 'npx', args: ['-y', 'srv'], env: { KEY: 'plain' } },
    { name: 'web', type: 'sse', url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: '${secrets:mcp-tok}' } },
    { name: 'bad' },                       // command/url 無し → スキップ
    { command: 'x' },                      // name 無し → スキップ
    { name: 'env-ref', command: 'c', env: { V: '${env:__TEST_NONEXISTENT__}' } }] };
  const out = mcpServersForSession(cfg, { mcpTokens: { 'mcp-tok': 'TOK' } },
    (w) => warns.push(w));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { name: 'fs', command: 'npx', args: ['-y', 'srv'], env: { KEY: 'plain' } });
  assert.deepEqual(out[1], { name: 'web', type: 'sse', url: 'http://127.0.0.1:9/mcp',
    headers: { Authorization: 'TOK' } });
  assert.equal(out[2].env.V, '${env:__TEST_NONEXISTENT__}'); // 未解決はリテラル維持
  assert.equal(warns.length, 2);
  assert.deepEqual(mcpServersForSession({}, {}), []);
});

test('判定ブロック抽出: assess/split', () => {
  const m = 'text <!--devin-assess {"feasible":"yes"} devin-assess--> tail'.match(ASSESS_RE);
  assert.equal(JSON.parse(m[1].trim()).feasible, 'yes');
  const s = 'log <!--split {"newKey":"o/r issue#9"} split-->'.match(SPLIT_RE);
  assert.equal(JSON.parse(s[1].trim()).newKey, 'o/r issue#9');
});
