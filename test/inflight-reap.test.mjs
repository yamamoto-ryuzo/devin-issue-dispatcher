import test from 'node:test';
import assert from 'node:assert/strict';
import { pidAlive, reapOrphanedInflight } from '../inflight-reap.mjs';
import { isLifecycleActive } from '../core-logic.mjs';

const K = 'owner/repo issue#1';

test('pidAlive: 自プロセスは生存、存在しない pid は ESRCH で死亡', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 30), false);
});

test('子 pid 死亡済みの inflight は解除され再候補化される', () => {
  const tasks = { [K]: { inflight: 'assess', inflightAt: '2026-01-01T00:00:00.000Z',
    inflightPid: 1234 } };
  const reaped = reapOrphanedInflight(tasks, { isAlive: () => false });
  assert.deepEqual(reaped, [K]);
  assert.equal(tasks[K].inflight, undefined);
  assert.equal(tasks[K].inflightAt, undefined);
  assert.equal(tasks[K].inflightPid, undefined);
  assert.ok(tasks[K].inflightClearedAt);
  // 回収後は discover の isLifecycleActive が非 active を返し再候補化される
  assert.equal(isLifecycleActive(tasks[K]), false);
});

test('子 pid 生存中の inflight は保持される', () => {
  const tasks = { [K]: { inflight: 'assess', inflightAt: '2026-01-01T00:00:00.000Z',
    inflightPid: 1234 } };
  const reaped = reapOrphanedInflight(tasks, { isAlive: () => true });
  assert.deepEqual(reaped, []);
  assert.equal(tasks[K].inflight, 'assess');
  assert.equal(tasks[K].inflightPid, 1234);
});

test('pid 未記録の旧形式 inflight は残る（inflightAt 期限切れへフォールバック）', () => {
  const tasks = { [K]: { inflight: 'assess', inflightAt: '2026-01-01T00:00:00.000Z' } };
  const reaped = reapOrphanedInflight(tasks, { isAlive: () => false });
  assert.deepEqual(reaped, []);
  assert.equal(tasks[K].inflight, 'assess');
});

test('running 管理下の key は pid 死亡でも触らない', () => {
  const tasks = { [K]: { inflight: 'assess', inflightAt: '2026-01-01T00:00:00.000Z',
    inflightPid: 1234 } };
  const reaped = reapOrphanedInflight(tasks,
    { running: new Set([K]), isAlive: () => false });
  assert.deepEqual(reaped, []);
  assert.equal(tasks[K].inflight, 'assess');
});

test('inflight 無しで残った孤児 inflightPid は掃除される', () => {
  const tasks = { [K]: { status: 'done', inflightPid: 1234 } };
  const reaped = reapOrphanedInflight(tasks);
  assert.deepEqual(reaped, [K]);
  assert.equal(tasks[K].inflightPid, undefined);
  assert.equal(tasks[K].status, 'done');
});
