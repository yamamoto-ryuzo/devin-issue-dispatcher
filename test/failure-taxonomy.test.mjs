import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyFailure, recordFailure, readFailures, aggregateFailures }
  from '../failure-taxonomy.mjs';

test('issue #106 例の既定分類', () => {
  assert.deepEqual(classifyFailure('verify-ng'),
    { axis: 'governance.resume', tag: 'completion' });
  assert.deepEqual(classifyFailure('stale-running'),
    { axis: 'governance.resume', tag: 'ordering' });
  assert.deepEqual(classifyFailure('unattributed-revert'),
    { axis: 'structure.representation', tag: 'attribution' });
  assert.equal(classifyFailure('unknown-kind').axis, 'processing.execution');
});

test('record→read→aggregate の往復', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ft-')), 'failures.jsonl');
  recordFailure({ kind: 'verify-ng', repo: 'r/a', number: 1, type: 'issue', key: 'r/a issue#1' }, { file });
  recordFailure({ kind: 'impl-failed', repo: 'r/a', number: 2, type: 'issue' }, { file });
  recordFailure({ kind: 'impl-failed', repo: 'r/a', number: 3, type: 'issue',
    axis: 'connection.condition', cause: 'assess→impl で条件落ち' }, { file });
  const recs = readFailures({ file });
  assert.equal(recs.length, 3);
  assert.equal(recs[2].axis, 'connection.condition'); // cause 指定で上書き可
  const agg = aggregateFailures(recs);
  assert.equal(agg.total, 3);
  assert.equal(agg.byKind['impl-failed'], 2);
  assert.equal(agg.byAxis['governance.resume'], 1);
  assert.equal(agg.trend.last7d, 3);
});
