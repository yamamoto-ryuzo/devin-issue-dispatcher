import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../metrics.mjs';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const day = 86400e3;

test('computeMetrics: 期間フィルタと assess 分布', () => {
  const state = { tasks: {
    'a/i#1': { assessedAt: iso(NOW - day), assess: { category: 'auto', risk: 'low', feasible: 'yes' } },
    'a/i#2': { assessedAt: iso(NOW - 2 * day), assess: { category: 'review', risk: 'high', feasible: 'yes' } },
    'a/i#3': { assessedAt: iso(NOW - day), assess: { error: 'exit 1' } },
    'a/i#old': { assessedAt: iso(NOW - 30 * day), assess: { category: 'auto', risk: 'low' } },
  } };
  const m = computeMetrics(state, 7, NOW);
  assert.equal(m.tasks.total, 3);
  assert.equal(m.assess.attempted, 3);
  assert.equal(m.assess.ok, 2);
  assert.equal(m.assess.failed, 1);
  assert.deepEqual(m.assess.category, { auto: 1, review: 1 });
  assert.deepEqual(m.assess.risk, { low: 1, high: 1 });
  assert.deepEqual(m.assess.feasible, { yes: 2 });
});

test('computeMetrics: impl/verify の OK・NG・failed・running', () => {
  const T = iso(NOW - day);
  const state = { tasks: {
    'a/i#ok': { assessedAt: T, implLog: 'x', status: 'impl-done' },
    'a/i#ng': { assessedAt: T, implLog: 'x', status: 'needs-review' },
    'a/i#fail': { assessedAt: T, implLog: 'x', status: 'failed' },
    'a/i#run': { assessedAt: T, engineUsed: 'copilot', status: 'running' },
    'a/i#vok': { assessedAt: T, implLog: 'x', verifyLog: 'v', status: 'closed', createdPr: 1 },
    'a/i#vng': { assessedAt: T, implLog: 'x', verifyLog: 'v', status: 'verify-ng' },
    'a/i#assess': { assessedAt: T, assess: { category: 'review' }, status: 'needs-review' },
  } };
  const m = computeMetrics(state, 7, NOW);
  assert.equal(m.impl.attempted, 6);
  assert.equal(m.impl.ok, 3);          // impl-done + closed + verify-ng
  assert.equal(m.impl.ng, 1);
  assert.equal(m.impl.failed, 1);
  assert.equal(m.impl.running, 1);
  assert.equal(m.verify.attempted, 2);
  assert.equal(m.verify.ok, 1);
  assert.equal(m.verify.ng, 1);
});

test('computeMetrics: 所要時間（検出→完了・セッション）', () => {
  const s = NOW - 10 * day;                       // 検出=10日前
  const state = { tasks: {
    'a/i#1': { assessedAt: iso(s), startedAt: iso(NOW - 120 * 60000),
      finishedAt: iso(NOW - 60 * 60000), closedAt: iso(NOW - 30 * 60000),
      implLog: 'x', status: 'closed' },
    'a/i#2': { assessedAt: iso(NOW - 2 * day), verifyLog: 'v',
      startedAt: iso(NOW - 50 * 60000), finishedAt: iso(NOW - 20 * 60000),
      status: 'done' },
  } };
  const m = computeMetrics(state, 30, NOW);
  assert.equal(m.durations.detectToDone.count, 1);
  assert.ok(Math.abs(m.durations.detectToDone.maxMin - (10 * day - 30 * 60000) / 60000) < 0.2);
  assert.equal(m.durations.implSession.count, 1);
  assert.equal(m.durations.implSession.avgMin, 60);
  assert.equal(m.durations.verifySession.count, 1);
  assert.equal(m.durations.verifySession.avgMin, 30);
});

test('computeMetrics: 空 state・境界値', () => {
  assert.equal(computeMetrics({}, 7, NOW).tasks.total, 0);
  assert.equal(computeMetrics(null, 7, NOW).tasks.total, 0);
  const m = computeMetrics({ tasks: { 'a/i#1': {} } }, 7, NOW);
  assert.equal(m.tasks.total, 0);                 // タイムスタンプ無しは集計対象外
  assert.equal(m.durations.detectToDone, null);
});
