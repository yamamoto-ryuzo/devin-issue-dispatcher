/**
 * 状態遷移の中核ロジック（純粋関数・外部依存なし）
 * dispatcher.mjs から分離したテスト可能なコア。
 * gh/devin.exe/時計/FS へは一切触れず、必要な値（ラベル定義・上限・
 * 実行中集合等）はすべて引数注入（DI）とする。
 */

export const RISK_RANK = { low: 0, medium: 1, high: 2 };
export const CAT_RANK = ['auto', 'review', 'human', 'reject'];
export const VERDICT_STEPS = { risk: ['low', 'medium', 'high'], category: CAT_RANK };

// verify NG 差し戻し時に保存済み verdict の category/risk を1ランク引き上げる。
// 上限（reject/high）では据え置き、理由は reason 末尾へ引き継ぐ
export function escalateVerdict(assess, why) {
  if (!assess || assess.error) return assess;
  const up = (steps, v) =>
    steps[Math.min(Math.max(steps.indexOf(v), 0) + 1, steps.length - 1)];
  return { ...assess,
    risk: up(VERDICT_STEPS.risk, assess.risk),
    category: up(VERDICT_STEPS.category, assess.category),
    reason: `${assess.reason ?? ''} [verify-ng差し戻し: ${why}]`.trim() };
}

// verdict が自動処理範囲を超えたか（引き上げ後の判定に使用）
export function verdictOverLimit(a, { maxRisk = 'medium', maxCat = 'review' } = {}) {
  return !a || a.category === 'reject'
    || (RISK_RANK[a.risk] ?? 2) > (RISK_RANK[maxRisk] ?? 1)
    || CAT_RANK.indexOf(a.category) > CAT_RANK.indexOf(maxCat);
}

// コミットメッセージ中の課題番号を解釈（末尾 `Issue: #N` トレーラー優先、(#N) も可）
export function parseIssueRef(msg) {
  const s = String(msg ?? '');
  const t = s.match(/Issue:[ ]*#([0-9]+)/) || s.match(/[(]#([0-9]+)[)]/);
  return t ? +t[1] : null;
}

// 処理結果 → GitHub ラベル操作 {add, remove}（dispatcher の setLabel 呼び出し規則）
export function labelsForResult(post, LABEL) {
  switch (post) {
    case 'impl-done':
      return { add: [LABEL.implDone], remove: [LABEL.running] };
    case 'done':
      return { add: [LABEL.done], remove: [LABEL.running] };
    case 'needs-review':
      return { add: [LABEL.needsReview], remove: [LABEL.running] };
    case 'failed':
      return { add: [LABEL.failed], remove: [LABEL.running, LABEL.implDone] };
    case 'running':
      return { add: [LABEL.running], remove: [] };
    default:
      return { add: [], remove: [] };
  }
}

// 二重起動防止: 実行中・キュー待ち・委譲中・running ラベルのいずれかなら true
export function isInFlight(key, { tasks = {}, running = new Set(), queued = new Set(), runningLabel = false } = {}) {
  const t = tasks[key] ?? {};
  return running.has(key) || queued.has(key) || runningLabel ||
    !!(t.inflight || t.chatDelegated || t.status === 'running');
}

// 委譲 impl/verify の終端判定。watchImpl の通常完了・recordWatchTimeout・
// 起動時走査・dispatcher スイープの全経路で同じ規則を使う。
// issue:  verify=closed→done / AI:impl-done→impl-done / 無→verify-ng
//         impl  =AI:impl-done→impl-done / 無→needs-review
// pr:     旧経路（常に done）
export function resolveDelegatedStatus(delegated,
  { state, labels = [], flag = 'AI:impl-done', isPr = false } = {}) {
  if (isPr) return 'done';
  if (delegated === 'verify') {
    if (state === 'CLOSED') return 'done';
    return labels.includes(flag) ? 'impl-done' : 'verify-ng';
  }
  return labels.includes(flag) ? 'impl-done' : 'needs-review';
}

// 委譲滞留判定: chatDelegated が残り chatResult が無いまま
// delegatedAt から staleMs 超過した課題は回収対象（control 起動時走査・
// dispatcher スイープ共通の条件）
export function isDelegatedStale(task, { now = Date.now(), staleMs = 90 * 60 * 1000 } = {}) {
  if (!task?.chatDelegated || task.chatResult || !task.delegatedAt) return false;
  const at = new Date(task.delegatedAt).getTime();
  return Number.isFinite(at) && now - at > staleMs;
}
