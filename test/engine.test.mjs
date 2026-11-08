import test from 'node:test';
import assert from 'node:assert/strict';
import { engineSendCore, injectExtraPrompt, assertApiUrlSafe,
         ASSESS_RE, IMPLPR_RE, PRURL_RE } from '../engine.mjs';

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
  assert.deepEqual(body, { provider: 'copilot', prompt: 'p', model: 'gpt-x' });
  const un2 = mockFetch(async () => res({ error: 'denied' }, false, 403));
  await assert.rejects(() => engineSendCore({}, '', 'copilot', 'p'), /denied/);
  un2();
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

test('判定ブロック抽出: assess/impl-pr/PR URL', () => {
  const m = 'text <!--devin-assess {"feasible":"yes"} devin-assess--> tail'.match(ASSESS_RE);
  assert.equal(JSON.parse(m[1].trim()).feasible, 'yes');
  const p = 'log <!--impl-pr {"prKey":"o/r pr#5"} impl-pr-->'.match(IMPLPR_RE);
  assert.equal(JSON.parse(p[1].trim()).prKey, 'o/r pr#5');
  assert.equal('see https://github.com/o/r/pull/42'.match(PRURL_RE)[1], '42');
});
