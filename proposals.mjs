/**
 * 評価セッションが出力する proposals（語彙・判定種別の新設提案）の蓄積 (#108)。
 * <!--devin-assess--> JSON の任意 proposals[] を proposals.json へ集約する。
 * 同じ kind+target+neighbor_of で束ね（statement の字面では束ねない）、
 * 束内の confidence:high 件数が閾値（既定3件）へ達したら「設定候補」として
 * /api/candidates 経由でパネルへ提示し、人の採否を待つ
 * （taxonomy §2.2「設定候補」機構の簡易版）。
 *
 * proposals.json 形式:
 *   { bundles: { "<kind>|<target>|<neighbor_of昇順join>": {
 *       kind, target, neighbor_of[], count, high, statements[], sources[],
 *       firstAt, lastAt, readyAt? } } }
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const PROPOSAL_KINDS = ['value', 'category', 'risk', 'label'];
export const DEFAULT_THRESHOLD = 3;
const MAX_STATEMENTS = 8; // 束ごとに残す代表 statement 数（古い順に落とす）
const MAX_SOURCES = 30;   // 束ごとに残す出典（課題キー）数

// 束ねキー: statement の字面ではなく kind+target+neighbor_of の構造で束ねる。
// neighbor_of は順序を問わないためソートして正規化する
export function proposalSig(p) {
  const nb = (Array.isArray(p?.neighbor_of) ? p.neighbor_of : [])
    .map((s) => String(s).trim()).filter(Boolean).sort();
  return `${String(p?.kind ?? '').trim()}|${String(p?.target ?? '').trim()}|${nb.join(',')}`;
}

// 出力 JSON の proposals を検証して有効分だけ返す（省略可・後方互換。
// kind/target/statement が欠ける要素は提案として成立しないため捨てる）
export function validProposals(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const kind = String(p.kind ?? '').trim();
    const target = String(p.target ?? '').trim();
    const statement = String(p.statement ?? '').trim();
    if (!PROPOSAL_KINDS.includes(kind) || !target || !statement) continue;
    out.push({ kind, target,
      neighbor_of: (Array.isArray(p.neighbor_of) ? p.neighbor_of : [])
        .map((s) => String(s).trim()).filter(Boolean),
      statement: statement.slice(0, 300),
      confidence: ['low', 'medium', 'high'].includes(p.confidence) ? p.confidence : 'medium' });
  }
  return out;
}

export function loadProposals(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { bundles: {} }; }
}

const writeAtomic = (path, obj) => {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
};

// 提案を束へ追記する。返り値: 今回の追記で新たに閾値到達（設定候補化）した束の sig
export function recordProposals(path, key, list, threshold = DEFAULT_THRESHOLD) {
  const ps = validProposals(list);
  if (!ps.length) return [];
  const store = loadProposals(path);
  store.bundles ??= {};
  const now = new Date().toISOString();
  const ready = [];
  for (const p of ps) {
    const sig = proposalSig(p);
    const b = store.bundles[sig] ??= { kind: p.kind, target: p.target,
      neighbor_of: [...p.neighbor_of].sort(), count: 0, high: 0,
      statements: [], sources: [], firstAt: now, lastAt: now };
    b.count += 1;
    if (p.confidence === 'high') b.high += 1;
    b.lastAt = now;
    if (!b.statements.includes(p.statement)) {
      b.statements.push(p.statement);
      if (b.statements.length > MAX_STATEMENTS) b.statements.shift();
    }
    b.sources.push({ key, confidence: p.confidence, at: now });
    if (b.sources.length > MAX_SOURCES) b.sources.shift();
    if (!b.readyAt && b.high >= threshold) { b.readyAt = now; ready.push(sig); }
  }
  writeAtomic(path, store);
  return ready;
}

// パネル表示用の一覧。設定候補（閾値到達）を先頭、その後は high/count の多い順。
// sources は直近3件に絞って返す（全件は proposals.json を参照）。
// 未達の束も消さずに全件返す（採否は人が語彙表/_assess.md/config の更新で行う）
export function listProposals(path, threshold = DEFAULT_THRESHOLD) {
  const { bundles } = loadProposals(path);
  return Object.entries(bundles ?? {}).map(([sig, b]) => ({ sig,
    kind: b.kind, target: b.target, neighbor_of: b.neighbor_of ?? [],
    count: b.count ?? 0, high: b.high ?? 0,
    statements: b.statements ?? [],
    sources: (b.sources ?? []).slice(-3),
    firstAt: b.firstAt ?? null, lastAt: b.lastAt ?? null,
    readyAt: b.readyAt ?? null,
    ready: !!b.readyAt || (b.high ?? 0) >= threshold }))
    .sort((a, b) => (Number(b.ready) - Number(a.ready))
      || (b.high - a.high) || (b.count - a.count)
      || String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')));
}
