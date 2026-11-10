// state.json の tasks から期間集計を行う純粋関数モジュール。
// /api/metrics?days=N（control.mjs）とパネルの集計表示が利用する。
// 集計対象: 期間内に何らかの活動（タイムスタンプ更新）があった課題。

const DAY_MS = 86400e3;
const STAMP_FIELDS = ['assessedAt', 'startedAt', 'finishedAt', 'prAt', 'closedAt',
  'inflightClearedAt', 'splitAt', 'engineUsedAt', 'delegatedAt'];
// impl が完了扱いになる status（verify 以降へ進んだ = impl セッション成功）
const IMPL_OK = ['impl-done', 'verify-ng', 'done', 'closed'];

const parseTs = (v) => {
  const d = v ? Date.parse(v) : NaN;
  return Number.isFinite(d) ? d : null;
};
const inc = (obj, k) => { obj[k ?? 'unknown'] = (obj[k ?? 'unknown'] ?? 0) + 1; };

function spanStats(mins) {
  if (!mins.length) return null;
  const s = [...mins].sort((a, b) => a - b);
  const r = (x) => Math.round(x * 10) / 10;
  return { count: s.length, avgMin: r(s.reduce((a, b) => a + b, 0) / s.length),
    medianMin: r(s[Math.floor(s.length / 2)]), minMin: r(s[0]), maxMin: r(s[s.length - 1]) };
}

export function computeMetrics(state, days = 7, now = Date.now()) {
  const since = now - days * DAY_MS;
  const entries = Object.entries(state?.tasks ?? {});
  const active = entries.filter(([, t]) => {
    const stamps = STAMP_FIELDS.map((f) => parseTs(t?.[f])).filter((v) => v != null);
    return stamps.length > 0 && Math.max(...stamps) >= since;
  });
  const m = {
    days, since: new Date(since).toISOString(),
    tasks: { total: active.length, byStatus: {} },
    assess: { attempted: 0, ok: 0, ng: 0, failed: 0, running: 0,
      category: {}, risk: {}, feasible: {} },
    impl: { attempted: 0, ok: 0, ng: 0, failed: 0, running: 0 },
    verify: { attempted: 0, ok: 0, ng: 0, failed: 0, running: 0 },
  };
  const detectToDone = [], implDur = [], verifyDur = [];
  for (const [, t] of active) {
    const st = t.status ?? 'none';
    inc(m.tasks.byStatus, st);
    // assess: assessedAt があれば評価セッション実施済み。assess.error は評価失敗
    if (t.assessedAt) {
      m.assess.attempted++;
      if (t.assess?.error) m.assess.failed++;
      else if (t.assess) {
        m.assess.ok++;
        inc(m.assess.category, t.assess.category);
        inc(m.assess.risk, t.assess.risk);
        inc(m.assess.feasible, t.assess.feasible);
      }
    }
    // impl: implLog・委譲実行（engineUsed）・verify 以降到達のいずれかで実施済み。
    // needs-review 到達は対応困難（ループ上限）= NG、verify 後の failed は verify 側で計上
    const implRan = !!(t.implLog || t.verifyLog || t.engineUsed || t.createdPr
      || IMPL_OK.includes(st));
    if (implRan) {
      m.impl.attempted++;
      if (st === 'running') m.impl.running++;
      else if (st === 'failed' && !t.verifyLog) m.impl.failed++;
      else if (st === 'needs-review') m.impl.ng++;
      else m.impl.ok++;
    }
    // verify: verifyLog があれば再検証実施済み。done/closed/createdPr=push 済みは OK
    if (t.verifyLog) {
      m.verify.attempted++;
      if (st === 'running') m.verify.running++;
      else if (st === 'done' || st === 'closed' || t.createdPr) m.verify.ok++;
      else if (st === 'failed') m.verify.failed++;
      else m.verify.ng++;    // verify-ng / needs-review（上限到達）等
    }
    // 所要時間: 課題の最初の記録時刻 → 完了（closedAt / prAt）
    const stamps = STAMP_FIELDS.map((f) => parseTs(t[f])).filter((v) => v != null);
    const end = parseTs(t.closedAt) ?? parseTs(t.prAt);
    if (stamps.length && end != null && end > Math.min(...stamps))
      detectToDone.push((end - Math.min(...stamps)) / 60000);
    // セッション時間: startedAt→finishedAt（最終セッション。
    // verifyLog の有無で impl / verify セッションを区別）
    const s0 = parseTs(t.startedAt), s1 = parseTs(t.finishedAt);
    if (s0 != null && s1 != null && s1 > s0)
      (t.verifyLog ? verifyDur : implDur).push((s1 - s0) / 60000);
  }
  m.durations = {
    detectToDone: spanStats(detectToDone),
    implSession: spanStats(implDur),
    verifySession: spanStats(verifyDur),
  };
  return m;
}
