import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklistOf } from '../core-logic.mjs';

test('checklistOf: - [ ] / - [x] の進捗を解析する', () => {
  const cl = checklistOf(
    '## 受け入れ条件\n- [x] 表示する\n- [ ] 判定材料へ渡す\n- [X] 大文字も完了');
  assert.equal(cl.total, 3);
  assert.equal(cl.done, 2);
  assert.deepEqual(cl.items.map((i) => i.text),
    ['表示する', '判定材料へ渡す', '大文字も完了']);
});

test('checklistOf: 字下げ・引用内の項目も拾う', () => {
  const cl = checklistOf('  - [ ] 字下げ\n> - [x] 引用');
  assert.equal(cl.total, 2);
  assert.equal(cl.done, 1);
});

test('checklistOf: チェックリストが無ければ null（従来どおり）', () => {
  assert.equal(checklistOf('plain text\n- 通常リスト\n行中 - [ ] は無視'), null);
  assert.equal(checklistOf(''), null);
  assert.equal(checklistOf(null), null);
});
