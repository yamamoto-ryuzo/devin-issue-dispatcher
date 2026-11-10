// 状態遷移ロジックの fixture 駆動テスト（外部依存なし・DI 済み関数のみ）
import test from 'node:test';
import assert from 'node:assert/strict';
import { escalateVerdict, verdictOverLimit, parseIssueRef,
  labelsForResult, isInFlight } from '../core-logic.mjs';

const L = { running: 'devin:running', done: 'devin:done', failed: 'devin:failed',
  needsReview: 'devin:needs-review', rejected: 'devin:rejected', implDone: 'AI:impl-done' };

// ---- escalateVerdict: 1ランク引き上げ ----
test('escalate: auto/low -> review/medium', () => {
  const v = escalateVerdict({ category: 'auto', risk: 'low', reason: 'ok' }, 'NG1');
  assert.equal(v.category, 'review');
  assert.equal(v.risk, 'medium');
  assert.match(v.reason, /verify-ng差し戻し: NG1/);
});
test('escalate: human/high -> reject/high（上限到達で据え置き）', () => {
  const v = escalateVerdict({ category: 'human', risk: 'high', reason: '' }, 'x');
  assert.equal(v.category, 'reject');
  assert.equal(v.risk, 'high');
});
test('escalate: reject/high は据え置き', () => {
  const v = escalateVerdict({ category: 'reject', risk: 'high' }, 'x');
  assert.equal(v.category, 'reject');
});
test('escalate: null/error verdict はそのまま返す', () => {
  assert.equal(escalateVerdict(null, 'x'), null);
  const e = { error: 'boom' };
  assert.equal(escalateVerdict(e, 'x'), e);
});

// ---- verdictOverLimit ----
test('overLimit: auto/low・review/medium は範囲内', () => {
  assert.equal(verdictOverLimit({ category: 'auto', risk: 'low' }), false);
  assert.equal(verdictOverLimit({ category: 'review', risk: 'medium' }), false);
});
test('overLimit: human 判定・high リスク・reject は範囲外', () => {
  assert.equal(verdictOverLimit({ category: 'human', risk: 'low' }), true);
  assert.equal(verdictOverLimit({ category: 'auto', risk: 'high' }), true);
  assert.equal(verdictOverLimit({ category: 'reject', risk: 'low' }), true);
});
test('overLimit: null verdict は範囲外扱い・上限変更で挙動変化', () => {
  assert.equal(verdictOverLimit(null), true);
  assert.equal(verdictOverLimit({ category: 'auto', risk: 'high' }, { maxRisk: 'high' }), false);
});

// ---- parseIssueRef: 帰属チェック ----
test('parseIssueRef: (#N) と Issue: #N を解釈', () => {
  assert.equal(parseIssueRef('feat: x (#12)'), 12);
  assert.equal(parseIssueRef('feat: x\n\nIssue: #34'), 34);
});
test('parseIssueRef: トレーラー優先・番号なしは null', () => {
  assert.equal(parseIssueRef('a (#1) Issue: #2'), 2);
  assert.equal(parseIssueRef('no ref'), null);
  assert.equal(parseIssueRef(''), null);
  assert.equal(parseIssueRef(null), null);
});

// ---- labelsForResult: ラベル遷移 ----
test('labels: impl-done/done/needs-review/failed/running の遷移', () => {
  assert.deepEqual(labelsForResult('impl-done', L),
    { add: ['AI:impl-done'], remove: ['devin:running'] });
  assert.deepEqual(labelsForResult('done', L),
    { add: ['devin:done'], remove: ['devin:running'] });
  assert.deepEqual(labelsForResult('needs-review', L),
    { add: ['devin:needs-review'], remove: ['devin:running'] });
  assert.deepEqual(labelsForResult('failed', L),
    { add: ['devin:failed'], remove: ['devin:running', 'AI:impl-done'] });
  assert.deepEqual(labelsForResult('running', L), { add: ['devin:running'], remove: [] });
});
test('labels: 未知の結果は no-op', () => {
  assert.deepEqual(labelsForResult('bogus', L), { add: [], remove: [] });
});

// ---- isInFlight: 二重起動防止 ----
test('inFlight: 清い課題は false・各種マーカーで true', () => {
  const k = 'o/r issue#1';
  assert.equal(isInFlight(k, {}), false);
  assert.equal(isInFlight(k, { tasks: { [k]: { inflight: 'impl' } } }), true);
  assert.equal(isInFlight(k, { tasks: { [k]: { chatDelegated: 'impl' } } }), true);
  assert.equal(isInFlight(k, { tasks: { [k]: { status: 'running' } } }), true);
  assert.equal(isInFlight(k, { running: new Set([k]) }), true);
  assert.equal(isInFlight(k, { queued: new Set([k]) }), true);
  assert.equal(isInFlight(k, { runningLabel: true }), true);
});
