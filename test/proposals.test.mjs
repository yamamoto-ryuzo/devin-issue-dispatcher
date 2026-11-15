// proposals（評価提案の束ね・蓄積）のテスト（#108）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { proposalSig, validProposals, loadProposals, recordProposals,
  listProposals } from '../proposals.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'proposals-test-'));
const P = join(tmp, 'proposals.json');
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// ---- proposalSig: neighbor_of は順序非依存で正規化 ----
test('sig: neighbor_of の順序差は同じ束になる', () => {
  const a = proposalSig({ kind: 'value', target: 'connection',
    neighbor_of: ['b.c', 'a.b'] });
  const b = proposalSig({ kind: 'value', target: 'connection',
    neighbor_of: ['a.b', 'b.c'] });
  assert.equal(a, b);
});
test('sig: kind/target/neighbor_of が違えば別の束', () => {
  const base = { kind: 'value', target: 'connection', neighbor_of: ['a.b'] };
  assert.notEqual(proposalSig({ ...base, kind: 'label' }), proposalSig(base));
  assert.notEqual(proposalSig({ ...base, target: 'other' }), proposalSig(base));
  assert.notEqual(proposalSig({ ...base, neighbor_of: ['x.y'] }), proposalSig(base));
});

// ---- validProposals: 省略可・後方互換 ----
test('valid: 未定義・非配列は空配列（後方互換）', () => {
  assert.deepEqual(validProposals(undefined), []);
  assert.deepEqual(validProposals('x'), []);
});
test('valid: kind/target/statement 欠落・未知 kind は捨てる', () => {
  const ok = { kind: 'value', target: 't', statement: 's' };
  const out = validProposals([ok,
    { kind: 'bogus', target: 't', statement: 's' },
    { kind: 'value', statement: 's' },
    { kind: 'value', target: 't' },
    null, 42]);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 'medium'); // 未指定の既定
});
test('valid: confidence は列挙外を medium へ寄せる', () => {
  const [p] = validProposals([{ kind: 'label', target: 't',
    statement: 's', confidence: 'sure' }]);
  assert.equal(p.confidence, 'medium');
});

// ---- recordProposals: 束ね蓄積と閾値到達 ----
test('record: 同じ kind+target+neighbor_of は字面が違っても束ねる', () => {
  const p1 = { kind: 'value', target: 'connection',
    neighbor_of: ['a.b'], statement: '文A', confidence: 'medium' };
  const p2 = { ...p1, statement: '文B', confidence: 'high' };
  recordProposals(P, 'o/r issue#1', [p1]);
  recordProposals(P, 'o/r issue#2', [p2]);
  const { bundles } = loadProposals(P);
  const sig = proposalSig(p1);
  assert.equal(Object.keys(bundles).length, 1);
  assert.equal(bundles[sig].count, 2);
  assert.equal(bundles[sig].high, 1);
  assert.deepEqual(bundles[sig].statements, ['文A', '文B']);
});
test('record: high が閾値到達で readyAt が立ち、以後は二重通知しない', () => {
  const p = { kind: 'risk', target: 'scope', neighbor_of: [],
    statement: 's', confidence: 'high' };
  assert.deepEqual(recordProposals(P, 'k1', [p], 3), []);
  assert.deepEqual(recordProposals(P, 'k2', [p], 3), []);
  const ready = recordProposals(P, 'k3', [p], 3);
  assert.equal(ready.length, 1);
  // 4件目以降は readyAt 済みなので新規到達として返さない
  assert.deepEqual(recordProposals(P, 'k4', [p], 3), []);
});

// ---- listProposals: 未達の束も消さず全件返す ----
test('list: ready 束が先頭・未達束も残る', () => {
  const out = listProposals(P, 3);
  assert.ok(out.length >= 2);
  assert.equal(out[0].ready, true);
  assert.ok(out.some((b) => b.kind === 'value' && b.ready === false));
});
test('list: 閾値を下げると未 readyAt の束も ready 扱いになる', () => {
  const out = listProposals(P, 1);
  assert.ok(out.every((b) => b.ready));
});
