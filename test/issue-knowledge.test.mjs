import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadKnowledgeEntries, knowledgeSection, MAX_ENTRIES, MAX_SECTION_CHARS,
  validateKnowledge, extractKnowledgeBlock, recordKnowledge, hasKnowledge,
  knowledgePath } from '../issue-knowledge.mjs';
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

// ---- #103 記録側 ----

test('validateKnowledge: 語彙外・unverified 欠落・not_verified 併記を弾く', () => {
  const base = {
    discovery: { perspective: ['symptom_report'] },
    resolution: { perspective: ['single_point_fix'],
      verification: { methods: ['guardrail'], unverified: [] } },
    classification: { axes: {}, review: 'candidate' },
    status: 'resolved', history: [],
  };
  assert.equal(validateKnowledge(base).ok, true);
  const bad = structuredClone(base);
  bad.discovery.perspective = ['bogus_value'];
  assert.match(validateKnowledge(bad).errors.join(' '), /語彙外/);
  const noUn = structuredClone(base);
  delete noUn.resolution.verification.unverified;
  assert.match(validateKnowledge(noUn).errors.join(' '), /unverified/);
  const nv = structuredClone(base);
  nv.resolution.verification.methods = ['not_verified', 'guardrail'];
  assert.match(validateKnowledge(nv).errors.join(' '), /not_verified/);
});

test('extractKnowledgeBlock: 最後のブロックを JSON として取り出す', () => {
  const text = 'a <!--issue-knowledge {"status":"resolved"} issue-knowledge--> b' +
    '<!--issue-knowledge\n{"status":"deferred"}\nissue-knowledge--> c';
  assert.equal(extractKnowledgeBlock(text).status, 'deferred');
  assert.equal(extractKnowledgeBlock('no block here'), null);
  assert.equal(extractKnowledgeBlock('<!--issue-knowledge {oops issue-knowledge-->'),
    null);
});

test('recordKnowledge: 正規化して保存・unverified 省略補完・語彙違反は弾く', () => {
  const root = mkroot();
  const r = recordKnowledge(root, task, { status: 'resolved',
    resolution: { perspective: ['guardrail_fix'],
      verification: { methods: ['reproduction_rerun'] } } }); // unverified 省略
  assert.ok(r.path, JSON.stringify(r));
  assert.ok(hasKnowledge(root, REPO, 999));
  const saved = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(saved.issue.number, 999);
  assert.equal(saved.issue.repo, REPO);
  assert.equal(saved.resolution.verification.unverified.length, 1); // 省略補完
  assert.equal(saved.classification.review, 'candidate');
  assert.ok(recordKnowledge(root, task,
    { discovery: { perspective: ['out_of_vocab'] } }).error);
});

test('recordKnowledge: 既存 confirmed の review を維持し前版を history へ', () => {
  const root = mkroot();
  const p = knowledgePath(root, REPO, 999);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ ...entry(999),
    classification: { axes: {}, review: 'confirmed',
      reviewed_by: 'user', reviewed_at: 'x' } }));
  recordKnowledge(root, task, {}, { status: 'deferred' });
  const saved = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(saved.classification.review, 'confirmed');
  assert.equal(saved.classification.reviewed_by, 'user');
  assert.equal(saved.history.length, 1);
  assert.equal(saved.history[0].status, 'resolved');
});

test('impl/verify プロンプトへナレッジブロック出力指示が入る', () => {
  const root = mkroot();
  for (const mode of ['impl', 'verify']) {
    const p = buildTaskPrompt({ ROOT: root, config: {}, task, mode });
    assert.match(p, /<!--issue-knowledge/);
    assert.match(p, /unverified/);
  }
});
