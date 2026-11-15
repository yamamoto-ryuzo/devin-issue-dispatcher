// work-queue.json の滞留アイテム回収（control.mjs /api/queue 投入時・
// mcp-server.mjs の queue_list/queue_claim 提供時で共用）
// - 対象課題が closed・終端ラベル付き・state.tasks 終端のアイテムを除去し、
//   同 key+mode の再投入が dedupe 409 で永久ブロックされるのを防ぐ
// - in-progress のまま staleMs 超放置されたアイテムを pending へ戻し、
//   queue_claim が立てた state.tasks の status:'running' + inflight を解除する
// state.tasks.status の終端値（これ以上自動処理が進まない状態）
const TERMINAL_STATUS = new Set(['done', 'failed', 'needs-review', 'rejected', 'closed']);

export const queueStaleMs = (cfg = {}) =>
  Math.max(+(cfg.queueStaleMinutes ?? 90), 1) * 60 * 1000;

/**
 * キューの滞留アイテムを掃除する。q と stateTasks は in-place で更新するので
 * 変更があった場合は呼び出し側でファイル保存する。
 * @param {object} q  work-queue.json 相当 { items: [] }
 * @param {object} o
 * @param {object}  o.issues         issues.json の issues マップ（open 課題のみ格納）
 * @param {string}  o.fetchedAt      issues.json の fetchedAt（ストア取得時刻）
 * @param {string[]} o.terminalLabels 終端ラベル名の配列
 * @param {object}  o.stateTasks     state.json の tasks マップ
 * @param {number}  o.staleMs        in-progress 放置判定（claimedAt 経過）
 * @param {number}  [o.now]
 * @returns {{removed:string[],requeued:string[],cleared:string[]}}
 */
export function sweepQueue(q, { issues = {}, fetchedAt = null, terminalLabels = [],
  stateTasks = {}, staleMs = Infinity, now = Date.now() } = {}) {
  const res = { removed: [], requeued: [], cleared: [] };
  const fetchMs = Date.parse(fetchedAt ?? '') || 0;
  // open 課題のみ格納するストアが空だと「全件 closed」と「取得失敗」を
  // 区別できないため、不在=closed 判定はストアが生きている時だけ適用する
  const storeLive = fetchMs > 0 && Object.keys(issues).length > 0;
  const kept = [];
  for (const it of q.items ?? []) {
    const queuedMs = Date.parse(it.queuedAt ?? '') || 0;
    const t = stateTasks[it.key];
    // state.tasks が終端: 終端化より後に投入されたアイテム（明示的な再投入）は残す
    const termAt = Date.parse(t?.finishedAt ?? t?.closedAt ?? '') || 0;
    const dead = (TERMINAL_STATUS.has(t?.status) && (!termAt || queuedMs < termAt))
      // open 課題ストアで終端ラベル付き（再投入済みでもラベル現存なら滞留扱い）
      || (issues[it.key]?.labels ?? []).some((l) => terminalLabels.includes(l))
      // ストア取得時点で open で無い = closed（取得後の投入は判定不能なので残す）
      || (storeLive && !issues[it.key] && queuedMs < fetchMs);
    if (dead) { res.removed.push(it.key); continue; }
    // claim 後に queue_done されず放置された in-progress は pending へ戻し、
    // 立てられていた status:'running' + inflight マーカーを解除する
    const claimMs = Date.parse(it.claimedAt ?? '') || 0;
    if (it.status === 'in-progress' && claimMs && now - claimMs > staleMs) {
      it.status = 'pending'; delete it.claimedAt;
      res.requeued.push(it.key);
      if (t && (t.inflight || t.status === 'running')) res.cleared.push(it.key);
    }
    kept.push(it);
  }
  q.items = kept;
  for (const key of res.cleared) {
    const t = stateTasks[key];
    if (t.status === 'running') delete t.status;
    delete t.inflight; delete t.inflightAt;
    t.inflightClearedAt = new Date(now).toISOString();
  }
  return res;
}
