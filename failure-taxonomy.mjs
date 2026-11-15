/**
 * dispatcher 運用上の失敗を4軸（processing/structure/connection/governance）で
 * 自己分類・蓄積する（#106）。分類レコードは issue-knowledge/failures.jsonl に
 * 1行1JSONで追記し、/api/failures で型ごとの集計・直近傾向を返す。
 *
 * レコード形式（#103 のナレッジ JSON に準拠・JSONL 追記型）:
 *   { ts, kind, repo, number, type, key, axis, tag, cause, note }
 *   axis: "processing.execution" | "connection.condition" | "structure.representation"
 *       | "governance.resume" 等（<軸>.<性質>）
 *   tag : 細分類（completion/contract/ordering/attribution/robustness 等）
 *   cause: 任意。verify/assess 系セッションが原因を特定できた場合に上書き出力
 *
 * 分類主体: 失敗回収時に dispatcher が機械的に付ける既定値（FAILURE_DEFAULTS）。
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const FAILURE_STORE = join(ROOT, 'issue-knowledge', 'failures.jsonl');

// 失敗イベント種別 → 4軸分類の既定値（原因の性質で分類・issue #106 の例に対応）
export const FAILURE_DEFAULTS = {
  'impl-failed':        { axis: 'processing.execution',    tag: 'completion'  },
  'verify-ng':          { axis: 'governance.resume',       tag: 'completion'  },
  'verify-failed':      { axis: 'processing.execution',    tag: 'completion'  },
  'run-abort':          { axis: 'processing.execution',    tag: 'robustness'  },
  'stale-running':      { axis: 'governance.resume',       tag: 'ordering'    },
  'orphaned-run':       { axis: 'governance.resume',       tag: 'ordering'    },
  'unattributed-revert':{ axis: 'structure.representation',tag: 'attribution' },
  'assess-handoff':     { axis: 'connection.condition',    tag: 'contract'    },
};

export function classifyFailure(kind) {
  return FAILURE_DEFAULTS[kind] ?? { axis: 'processing.execution', tag: 'unknown' };
}

/** 失敗イベントを1レコード追記する。失敗しても dispatcher 本体は止めない */
export function recordFailure(rec, { file = FAILURE_STORE } = {}) {
  try {
    const def = classifyFailure(rec.kind);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({
      ts: rec.ts ?? new Date().toISOString(),
      kind: rec.kind, repo: rec.repo ?? null, number: rec.number ?? null,
      type: rec.type ?? null, key: rec.key ?? null,
      axis: rec.axis ?? def.axis, tag: rec.tag ?? def.tag,
      cause: rec.cause ?? null, note: String(rec.note ?? '').slice(0, 300),
    }) + '\n');
    return true;
  } catch { return false; }
}

export function readFailures({ file = FAILURE_STORE } = {}) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** 型ごとの件数・直近7日 vs その前7日の傾向を集計（/api/failures 用） */
export function aggregateFailures(records, now = Date.now()) {
  const byKind = {}, byAxis = {}, byTag = {};
  let last7d = 0, prior7d = 0;
  for (const r of records) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (r.axis) byAxis[r.axis] = (byAxis[r.axis] ?? 0) + 1;
    if (r.tag) byTag[r.tag] = (byTag[r.tag] ?? 0) + 1;
    const age = now - new Date(r.ts).getTime();
    if (age <= 7 * 86400e3) last7d++;
    else if (age <= 14 * 86400e3) prior7d++;
  }
  return { total: records.length, byKind, byAxis, byTag,
    trend: { last7d, prior7d }, recent: records.slice(-10).reverse() };
}
