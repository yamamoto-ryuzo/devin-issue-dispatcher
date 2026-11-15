import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKnowledgeEntries, knowledgeSection, MAX_ENTRIES, MAX_SECTION_CHARS }
  from '../issue-knowledge.mjs';
import { buildTaskPrompt } from '../task-prompts.mjs';

const REPO = 'yamamoto-ryuzo/xxx';
const task = {
  repo: { github: REPO, path: '/tmp/xxx' }, type: 'issue',
  number: 999, title: '起票直後の重複キック対策', body: 'キックの連打で課題が二重起動する',
  url: 'https://example.test',
};
const entry = (n, over = {}) => ({
  issue: { repo: REPO, number: n, title: `起票直後の二重起動を直す ${n}` },
  resolution: { perspective: ['single_point_fix'],
    verification: { methods: ['guardrail'], unverified: ['同時実行'] },
    landed_in: 'abc123def456' },
  classification: { axes: { processing: 'ordering' }, review: 'candidate' },
  status: 'resolved', history: [], ...over,
});

const mkroot = () => mkdtempSync(join(tmpdir(), 'ik-'));
const put = (root, name, obj) => {
  const dir = join(root, 'issue-knowledge', 'xxx');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
};

test('類似エントリが座標・解決・検証・成否つきで差し込まれ確定/未確定を区別する', () => {
  const root = mkroot();
  put(root, '10.json', entry(10));
  put(root, '11.json', entry(11,
    { classification: { axes: { processing: 'ordering' }, review: 'confirmed' } }));
  const s = knowledgeSection(root, task);
  assert.match(s, /過去の同型課題/);
  assert.match(s, /\[確定\] #11/);   // confirmed 優先で先に来る
  assert.match(s, /\[未確定\] #10/);
  assert.match(s, /成否: resolved/);
  assert.match(s, /検証: guardrail/);
  assert.match(s, /未確認: 同時実行/);
  assert.match(s, /解決: single_point_fix/);
  assert.match(s, /座標: processing\.ordering/);
  assert.ok(s.indexOf('#11') < s.indexOf('#10')); // confirmed が先
});

test('類似しないエントリ・自分自身・失敗イベントJSONLは出さない', () => {
  const root = mkroot();
  put(root, '999.json', entry(999));                    // 自分自身 → 除外
  put(root, '20.json', entry(20,
    { issue: { repo: REPO, number: 20, title: '無関係な題名' } }));
  const dir = join(root, 'issue-knowledge');
  writeFileSync(join(dir, 'failures.jsonl'),            // issue フィールド無し → 対象外
    '{"ts":"t","kind":"verify-ng","axis":"governance.resume"}\n');
  assert.equal(knowledgeSection(root, task), '');
  assert.equal(loadKnowledgeEntries(dir).length, 2);    // issue 形だけ拾う
});

test('件数・文字数の上限が効く', () => {
  const root = mkroot();
  for (let i = 0; i < MAX_ENTRIES + 3; i++) put(root, `${i}.json`, entry(100 + i));
  const s = knowledgeSection(root, task);
  assert.equal((s.match(/^- \[(?:未確定|確定)\]/gm) ?? []).length, MAX_ENTRIES);
  assert.ok(s.length <= MAX_SECTION_CHARS);
  const tiny = knowledgeSection(root, task, { maxChars: 200 });
  assert.ok(tiny.length <= 200);
});

test('issue-knowledge ディレクトリが無くても空文字（assess 正常動作）', () => {
  assert.equal(knowledgeSection(mkroot(), task), '');
});

test('assess プロンプト末尾へ差し込まれ、他モード・該当無しでは出ない', () => {
  const root = mkroot();
  put(root, '30.json', entry(30));
  const p = buildTaskPrompt({ ROOT: root, config: {}, task, mode: 'assess' });
  assert.match(p, /過去の同型課題[\s\S]*$/);            // 末尾セクション
  const impl = buildTaskPrompt({ ROOT: root, config: {}, task, mode: 'impl' });
  assert.doesNotMatch(impl, /過去の同型課題/);
  const empty = buildTaskPrompt({ ROOT: mkroot(), config: {}, task, mode: 'assess' });
  assert.doesNotMatch(empty, /過去の同型課題/);
});
