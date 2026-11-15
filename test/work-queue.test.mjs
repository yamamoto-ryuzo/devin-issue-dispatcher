// work-queue.json 滞留アイテム回収の fixture 駆動テスト（外部依存なし・DI 済み関数のみ）
import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepQueue, queueStaleMs } from '../work-queue.mjs';

const K = 'r/o issue#1';
const TERMINAL = ['devin:done', 'devin:failed', 'devin:needs-review', 'devin:rejected', 'AI:impl-done'];
const item = (over = {}) => ({ key: K, mode: 'impl', status: 'pending',
  queuedAt: '2026-01-01T00:00:00.000Z', ...over });
const issuesWith = (entry) => ({ [K]: entry });
const ISSUES = { [K]: { labels: [] } };
const FETCHED = '2026-01-02T00:00:00.000Z';
const NOW = Date.parse('2026-01-03T00:00:00.000Z');
const sweep = (items, o = {}) => {
  const q = { items };
  const tasks = o.stateTasks ?? {};
  const r = sweepQueue(q, { issues: ISSUES, fetchedAt: FETCHED,
    terminalLabels: TERMINAL, stateTasks: tasks,
    staleMs: 90 * 60 * 1000, now: NOW, ...o });
  return { q, r, tasks };
};

test('closed 課題（open ストア不在）の滞留アイテムは除去される', () => {
  const { q, r } = sweep([item()], { issues: { 'r/o issue#2': { labels: [] } } });
  assert.equal(q.items.length, 0);
  assert.deepEqual(r.removed, [K]);
});

test('ストアが空（取得失敗と区別不可）なら不在だけでは除去しない', () => {
  const { q } = sweep([item()], { issues: {}, fetchedAt: null });
  assert.equal(q.items.length, 1);
});

test('ストア取得後に投入されたアイテムは不在でも残す（判定不能）', () => {
  const { q } = sweep([item({ queuedAt: '2026-01-03T00:00:00.000Z' })], { issues: {} });
  assert.equal(q.items.length, 1);
});

test('終端ラベル付き課題のアイテムは除去される', () => {
  const { q, r } = sweep([item()], { issues: issuesWith({ labels: ['devin:rejected'] }) });
  assert.equal(q.items.length, 0);
  assert.deepEqual(r.removed, [K]);
});

test('open 課題のアイテムは残る', () => {
  const { q, r } = sweep([item()]);
  assert.equal(q.items.length, 1);
  assert.deepEqual(r.removed, []);
});

test('state.tasks が終端ステータスのアイテムは除去される', () => {
  const { q } = sweep([item()], { stateTasks: {
    [K]: { status: 'rejected', finishedAt: '2026-01-01T12:00:00.000Z' } } });
  assert.equal(q.items.length, 0);
});

test('終端化より後に投入されたアイテム（明示的再投入）は残す', () => {
  const { q } = sweep([item({ queuedAt: '2026-01-02T00:00:00.000Z' })], { stateTasks: {
    [K]: { status: 'rejected', finishedAt: '2026-01-01T12:00:00.000Z' } } });
  assert.equal(q.items.length, 1);
});

test('stale な in-progress は pending へ戻り inflight/status を解除する', () => {
  const tasks = { [K]: { status: 'running', inflight: 'impl',
    inflightAt: '2026-01-02T10:00:00.000Z' } };
  const { q, r } = sweep([item({ status: 'in-progress',
    claimedAt: '2026-01-02T10:00:00.000Z' })], { stateTasks: tasks });
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].status, 'pending');
  assert.equal(q.items[0].claimedAt, undefined);
  assert.deepEqual(r.requeued, [K]);
  assert.deepEqual(r.cleared, [K]);
  assert.equal(tasks[K].status, undefined);
  assert.equal(tasks[K].inflight, undefined);
  assert.ok(tasks[K].inflightClearedAt);
});

test('fresh な in-progress はそのまま残る', () => {
  const tasks = { [K]: { status: 'running', inflight: 'impl' } };
  const { q, r } = sweep([item({ status: 'in-progress',
    claimedAt: '2026-01-02T23:00:00.000Z' })], { stateTasks: tasks });
  assert.equal(q.items[0].status, 'in-progress');
  assert.deepEqual(r.requeued, []);
  assert.equal(tasks[K].inflight, 'impl');
});

test('queueStaleMs は config の queueStaleMinutes（既定 90 分）を返す', () => {
  assert.equal(queueStaleMs({}), 90 * 60 * 1000);
  assert.equal(queueStaleMs({ queueStaleMinutes: 30 }), 30 * 60 * 1000);
});
