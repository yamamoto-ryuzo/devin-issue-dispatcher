/**
 * 課題発見ロジック（dispatcher.mjs / control.mjs 共用）
 *
 * gh CLI で各リポジトリの open Issue/PR を列挙し、
 * 「devin ラベル付き」または「autoTrigger 起点以降の新規作成」の候補を返す。
 * 読み取り専用（ラベル・コメント等の書き込みは行わない）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const execFileP = promisify(execFile);

export const keyOf = (repo, type, number) => `${repo} ${type}#${number}`;

export async function gh(ghArgs, opts = {}) {
  const { stdout } = await execFileP('gh', ghArgs, { maxBuffer: 16 * 1024 * 1024, ...opts });
  return stdout;
}

export async function ghJson(ghArgs) {
  return JSON.parse(await gh(ghArgs));
}

/**
 * 監視対象の全 open Issue/PR を横断検索で列挙。
 * repo 別に 2 クエリずつ投げる方式（9repo=18呼出）ではなく、
 * GitHub Search API 横断クエリで type 別 1 クエリずつ（計2呼出）に削減する。
 * ※ これは「課題の有無」の確認なので常にライブ取得（キャッシュしない）。
 */
export async function fetchAllOpen(config, log = () => {}) {
  const repos = (config.repos ?? []).map((r) => r.github);
  if (!repos.length) return [];
  const repoQ = repos.map((r) => `repo:${r}`).join(' ');
  const out = [];
  for (const type of ['issue', 'pr']) {
    try {
      const q = `is:${type} is:open ${repoQ}`;
      const res = await ghJson([
        'api', `search/issues?q=${encodeURIComponent(q)}&per_page=100`,
        '--jq', '{total:.total_count,items:.items}',
      ]);
      if ((res.total ?? 0) > 100) log(`search ${type}: ${res.total} items (only first 100 fetched)`);
      for (const it of res.items ?? []) {
        out.push({
          ghRepo: it.repository_url.split('/repos/')[1],
          type,
          number: it.number,
          title: it.title,
          body: it.body ?? '',
          url: it.html_url,
          labels: (it.labels ?? []).map((l) => l.name ?? l),
          createdAt: it.created_at,
          updatedAt: it.updated_at,
        });
      }
    } catch (e) {
      log(`search failed (${type}): ${e.message}`);
    }
  }
  return out;
}

/**
 * 検出結果をローカル issue ストア（issues.json）に書き込む。
 * 手動 dispatch (--task) や他経路が gh 再取得せずに課題の詳細を使えるようにする。
 * ストアには open 中の課題のみ保持（クローズされたものは次回書込で消える）。
 */
export function writeIssueStore(storePath, allItems) {
  const issues = {};
  for (const t of allItems) {
    issues[keyOf(t.ghRepo, t.type, t.number)] = {
      repo: t.ghRepo, type: t.type, number: t.number,
      title: t.title, body: t.body, url: t.url,
      labels: t.labels, createdAt: t.createdAt, updatedAt: t.updatedAt,
    };
  }
  const tmp = storePath + '.tmp';
  writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), issues }, null, 2));
  renameSync(tmp, storePath);
}

export function readIssueStore(storePath) {
  try { return JSON.parse(readFileSync(storePath, 'utf8')); }
  catch { return { fetchedAt: null, issues: {} }; }
}

/**
 * @param {object} o
 * @param {object} o.config  config.json 相当（repos, autoTriggerSince を参照）
 * @param {object} o.labels  { trigger, running, done, failed, needsReview }
 * @param {object} o.state   state.json 相当（deployedAt, tasks を参照）
 * @param {boolean} o.autoTrigger
 * @param {number} [o.maxNewPerPoll]
 * @param {string} [o.storePath] issues.json の保存先。指定時は検出結果をローカル保存する
 * @param {(msg:string)=>void} [o.log]
 */
export async function discover({ config, labels, state, autoTrigger, maxNewPerPoll = 5, log = () => {}, storePath = null }) {
  // autoTrigger の起点: "all"=全 open 課題 / ISO時刻 / 省略時は初回起動時刻
  const sinceRaw = config.autoTriggerSince;
  const sinceMs = autoTrigger
    ? (sinceRaw === 'all' ? -Infinity : new Date(sinceRaw ?? state.deployedAt).getTime())
    : -Infinity;
  const repoMap = new Map((config.repos ?? []).map((r) => [r.github, r]));

  const all = await fetchAllOpen(config, log);
  if (storePath) writeIssueStore(storePath, all);

  const found = [];
  let newCount = 0;
  const implDoneLabel = labels.implDone ?? 'AI:impl-done';
  for (const it of all) {
    const r = repoMap.get(it.ghRepo);
    if (!r) continue;
    const names = it.labels;
    // 終端ラベル付きは除外（needs-review/rejected はラベル除去で再候補化）
    if (names.includes(labels.done) || names.includes(labels.failed)
      || names.includes(labels.needsReview) || names.includes(labels.rejected)) continue;
    const key = keyOf(it.ghRepo, it.type, it.number);
    // AI:impl-done フラグ付き issue = 実装済み・未検証。再検証（PR処理）候補。
    // 新規課題カウントには含めない（既存課題の後段フェーズ）
    if (it.type === 'issue' && names.includes(implDoneLabel)) {
      found.push({ repo: r, type: it.type, number: it.number, title: it.title,
        body: it.body, url: it.url, labels: names,
        createdAt: it.createdAt, updatedAt: it.updatedAt, auto: true, verify: true });
      continue;
    }
    const st = state.tasks?.[key]?.status;
    // 候補 = 起点以降に作成された未処理の open Issue/PR（ラベルは使わない）
    // needs-review/rejected の履歴がある課題はラベル除去後に再候補化できる
    const isNew = autoTrigger && (!st || st === 'needs-review' || st === 'rejected' || st === 'verify-ng')
      && new Date(it.createdAt).getTime() >= sinceMs;
    if (!isNew) continue;
    if (newCount >= maxNewPerPoll) continue;
    newCount++;
    found.push({ repo: r, type: it.type, number: it.number, title: it.title,
      body: it.body, url: it.url, labels: names,
      createdAt: it.createdAt, updatedAt: it.updatedAt, auto: true });
  }
  return found;
}

/** discover の結果を candidates.json 保存用の軽量形へ整形（body 等は捨てる） */
export const toCandidate = (t, labels) => ({
  repo: t.repo.github,
  type: t.type,
  number: t.number,
  title: t.title,
  url: t.url,
  trigger: t.verify ? 'impl-done' : 'auto-new',
  createdAt: t.createdAt,
  runningLabel: t.labels.includes(labels.running),
  ...(t.verify ? { verify: true } : {}),
});
