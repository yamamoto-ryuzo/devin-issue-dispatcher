// dispatcher が立てた inflight マーカーに紐づく子プロセス（acp-runner）の
// 生存確認と、孤児化した inflight の回収を行う純粋ロジック。
// dispatcher 再起動・プロセス断で取り残された inflight が
// staleRunningMinutes（既定180分）まで課題をフリーズさせるのを防ぐ。

// process.kill(pid, 0) はプロセスの生存確認（ESRCH = プロセス不在）。
// EPERM 等の他エラーは「生存しているが操作できない」とみなし安全側に残す
// （誤回収による二重起動を避ける）
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

// tasks を in-place で更新し、回収・掃除した key の配列を返す。
// - inflight + inflightPid + pid 死亡: inflight を即時解除して再候補化
// - inflight 無しの孤児 inflightPid: 残骸として掃除
// - inflightPid 未記録（旧形式・チャット委譲）の inflight は触らない
//   （syncShared の inflightAt 期限切れ＝STALE_MS へフォールバック）
// running: 自プロセスが起動管理中の key 集合（対象外）
export function reapOrphanedInflight(tasks, { running, isAlive = pidAlive } = {}) {
  const reaped = [];
  for (const [key, t] of Object.entries(tasks ?? {})) {
    if (!t) continue;
    if (!t.inflight) {
      if (t.inflightPid) { delete t.inflightPid; reaped.push(key); }
      continue;
    }
    if (!t.inflightPid || running?.has(key) || isAlive(t.inflightPid)) continue;
    delete t.inflight; delete t.inflightAt; delete t.inflightPid;
    t.inflightClearedAt = new Date().toISOString();
    reaped.push(key);
  }
  return reaped;
}
