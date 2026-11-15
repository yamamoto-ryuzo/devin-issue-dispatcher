// code-watch.mjs の乖離検知テスト。実 fs.watch を使い、リポジトリ直下へ
// 一時 .mjs を作成して検知されることを確認する（終了後に削除）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCodeWatch, codeDrift } from '../code-watch.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = 'code-watch.test.tmp.mjs';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('初期状態では乖離なし', () => {
  initCodeWatch();
  assert.equal(codeDrift(), null);
});

test('ソース追加で乖離を検知する', async () => {
  initCodeWatch();
  try {
    writeFileSync(join(ROOT, TMP), '// drift test\n');
    let drifted = null;
    for (let i = 0; i < 40 && !drifted; i++) { await wait(100); drifted = codeDrift(); }
    assert.ok(drifted, '新規 .mjs 追加を検知できなかった');
    assert.ok(drifted.files.includes(TMP));
    assert.ok(drifted.since);
  } finally { rmSync(join(ROOT, TMP), { force: true }); }
});
