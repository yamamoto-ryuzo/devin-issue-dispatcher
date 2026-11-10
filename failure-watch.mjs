/**
 * エラー入力の自動取り込み（failure-watch）
 *
 * 監視 repo のワークフロー失敗（gh run list --status failure）と
 * dispatcher 自己異常（logs/dispatcher.log の ERROR/FATAL 連発）を検出し、
 * 失敗ログ抜粋付きの Issue を自動起票する。
 * config.autoIssueOnFailure=true のときのみ動作（既定 OFF）。
 * 重複防止は state.failureIssues の dedupe キー（failureDedupeHours, 既定24h）。
 */
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SELF_REPO = 'yamamoto-ryuzo/devin-issue-dispatcher';
const MAX_EXCERPT_CHARS = 3000;
const SELF_ERROR_THRESHOLD = 3; // 1ポーリング内でこの件数以上なら自己異常とみなす

async function failExcerpt(gh, repo, runId) {
  try {
    const out = await gh(['run', 'view', String(runId), '-R', repo, '--log-failed']);
    const lines = out.split('\n').filter((l) => l.trim());
    return lines.slice(-40).join('\n').slice(0, MAX_EXCERPT_CHARS);
  } catch { return ''; }
}

/** 1ポーリング分の失敗検出＋起票。dedupe/offset は state に記録する */
export async function checkFailures({ config, state, saveState, gh, ghJson, log,
  logFile = join(ROOT, 'logs', 'dispatcher.log') }) {
  if (config.autoIssueOnFailure !== true) return;
  const dedupeMs = (config.failureDedupeHours ?? 24) * 3600e3;
  state.failureIssues ??= {};
  const now = Date.now();
  const suppressed = (k) => {
    const rec = state.failureIssues[k];
    return rec && now - new Date(rec.at).getTime() < dedupeMs;
  };
  const fileIssue = async (key, repo, title, body, extra = {}) => {
    if (suppressed(key)) return false;
    try {
      const out = await gh(['issue', 'create', '-R', repo,
        '--title', title.slice(0, 120), '--body', body]);
      const m = String(out).match(/issues\/(\d+)/);
      state.failureIssues[key] =
        { issue: m ? +m[1] : null, at: new Date().toISOString(), ...extra };
      log('failure-watch: issue 起票 ' + String(out).trim());
      return true;
    } catch (e) {
      log('failure-watch ' + key + ': issue 起票失敗: ' + e.message);
      return false;
    }
  };

  // ---- 監視 repo のワークフロー失敗 ----
  for (const r of config.repos ?? []) {
    let runs;
    try {
      runs = await ghJson(['run', 'list', '-R', r.github, '--status', 'failure',
        '--limit', '3', '--json',
        'databaseId,name,displayTitle,url,createdAt,workflowName,conclusion']);
    } catch (e) {
      log('failure-watch ' + r.github + ': run list 取得失敗: ' + e.message);
      continue;
    }
    for (const run of runs ?? []) {
      const wf = run.workflowName || run.name || 'workflow';
      const key = 'wf:' + r.github + ':' + wf;
      const excerpt = await failExcerpt(gh, r.github, run.databaseId);
      await fileIssue(key, r.github,
        '[CI失敗] ' + wf + ': ' + (run.displayTitle || ''),
        '## 自動起票（ワークフロー失敗検出）\n\n' +
        '- ワークフロー: ' + wf + '\n' +
        '- ラン: ' + (run.url || String(run.databaseId)) + '\n' +
        '- 検出時刻: ' + (run.createdAt || '') + '\n\n' +
        '## 失敗ログ抜粋\n\n```\n' + (excerpt || '（ログ取得不可）') + '\n```\n\n' +
        '## 想定原因\n\n失敗ジョブの最終エラー行を起点に原因を調査してください。',
        { run: run.databaseId });
    }
  }

  // ---- dispatcher 自己異常（dispatcher.log の ERROR/FATAL 連発）----
  state.selfErrorScan ??= { offset: -1 };
  if (existsSync(logFile)) {
    const size = statSync(logFile).size;
    // 初回/サイズ縮小時は末尾から（過去ログで一括起票しない）
    const prev = state.selfErrorScan.offset;
    const off = prev < 0 || prev > size ? size : prev;
    state.selfErrorScan.offset = size; // 基線は常に末尾へ進める
    if (off < size) {
      const fd = openSync(logFile, 'r');
      const buf = Buffer.alloc(size - off);
      readSync(fd, buf, 0, buf.length, off);
      closeSync(fd);
      const hits = buf.toString('utf8').split(String.fromCharCode(10))
        .filter((l) => /ERROR|FATAL|fatal:|spawn error/i.test(l));
      if (hits.length >= SELF_ERROR_THRESHOLD) {
        await fileIssue('self:error', SELF_REPO,
          '[自己異常] dispatcher.log で ERROR/FATAL ' + hits.length + ' 件検出',
          '## 自動起票（dispatcher 自己異常検出）\n\n' +
          'ポーリング間隔内に ERROR/FATAL 行が ' + hits.length + ' 件記録されました。\n\n' +
          '## 該当ログ行（最大20件）\n\n```\n' +
          hits.slice(0, 20).join('\n') + '\n```\n\n' +
          '## 想定原因\n\nログ行の直前コンテキスト（logs/dispatcher.log）を確認し、' +
          '連続失敗の発生元（spawn 不可・通信断・設定不備等）を切り分けてください。',
          { hits: hits.length });
      }
    }
  }
  saveState(state);
}
