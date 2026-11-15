// control 再起動ヘルパー（POST /api/control/restart からデタッチ起動される）。
// 親 control プロセスが完全終了するのを待ってから control.mjs を起動する
// （ポート 8585 の二重バインドを防ぐため起動を遅らせる）。
// control はステートレス（状態は全て *.json へ永続化）なので即再起動してよい。
// 使い方: node restart-control.mjs <parentPid>
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const parent = Number(process.argv[2] || 0);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
};

// 親の終了を最大 10 秒待つ（このヘルパーは使い捨ての単発待機。常駐監視ではない）
const deadline = Date.now() + 10000;
while (parent && alive(parent) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
const child = spawn(process.execPath, [join(ROOT, 'control.mjs')], {
  cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore',
});
child.unref();
