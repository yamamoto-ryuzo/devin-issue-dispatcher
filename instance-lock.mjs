/**
 * dispatcher 単一インスタンスガード。
 * pidfile を排他作成（'wx'）し、既存時は PID 生存確認で stale を回収する。
 * ロック中はファイル内容 = 持ち主プロセスの PID。
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // 生存するがシグナル権限なし
};

// 取得できれば { ok: true }、生存中の持ち主がいれば { ok: false, pid }。
// stale（持ち主死亡・内容不正）は除去して再取得を試みる
export function tryAcquireLock(path) {
  for (let i = 0; i < 3; i++) {
    try {
      const fd = openSync(path, 'wx');
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = NaN;
      try { pid = parseInt(readFileSync(path, 'utf8'), 10); } catch { /* 読めない = stale */ }
      if (pidAlive(pid)) return { ok: false, pid };
      try { unlinkSync(path); } catch { /* 競合で消えたなら次周回の wx で再判定 */ }
    }
  }
  return { ok: false, pid: NaN };
}

// 自分が持ち主のロックのみ除去（他プロセスの pid が書かれていれば残す）
export function releaseLock(path) {
  try {
    if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
  } catch { /* 既に無い/他所有は無視 */ }
}
