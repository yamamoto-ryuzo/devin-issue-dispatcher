import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tryAcquireLock, releaseLock } from '../instance-lock.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'inst-lock-')), 'dispatcher.pid');

test('acquire succeeds, second acquire refused while holder alive', () => {
  const p = tmp();
  assert.equal(tryAcquireLock(p).ok, true);
  const r = tryAcquireLock(p); // 自プロセスの pid は生存 → 拒否
  assert.equal(r.ok, false);
  assert.equal(r.pid, process.pid);
});

test('releaseLock removes own lockfile', () => {
  const p = tmp();
  assert.equal(tryAcquireLock(p).ok, true);
  releaseLock(p);
  assert.equal(existsSync(p), false);
});

test('releaseLock keeps lockfile owned by another pid', () => {
  const p = tmp();
  writeFileSync(p, '1'); // pid 1 は自プロセスではない
  releaseLock(p);
  assert.equal(existsSync(p), true);
});

test('stale lock (dead pid) is reclaimed', async () => {
  const p = tmp();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((r) => child.on('exit', r));
  writeFileSync(p, String(child.pid));
  assert.equal(tryAcquireLock(p).ok, true);
});

test('garbage content is treated as stale and reclaimed', () => {
  const p = tmp();
  writeFileSync(p, 'not-a-pid');
  assert.equal(tryAcquireLock(p).ok, true);
});
