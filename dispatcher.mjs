#!/usr/bin/env node
/**
 * devin-agent dispatcher
 *
 * GitHub Issues/PR を定期的にポーリングし、トリガーラベルが付いた
 * 未処理の課題ごとに `devin -p` セッションを起動する常駐ディスパッチャー。
 *
 * 使い方:
 *   node dispatcher.mjs            # 常駐ループ
 *   node dispatcher.mjs --once     # 1サイクルだけ実行（起動も行う）
 *   node dispatcher.mjs --dry-run  # 検出のみ表示（起動・ラベル操作なし）
 *
 * 状態は state.json、セッション出力は logs/ に保存する。
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gh, ghJson, keyOf, discover, toCandidate, readIssueStore } from './discover.mjs';
import { buildTaskPrompt } from './task-prompts.mjs';
import { checkFailures } from './failure-watch.mjs';
import { RISK_RANK, CAT_RANK, VERDICT_STEPS, escalateVerdict, parseIssueRef,
  resolveDelegatedStatus, isDelegatedStale } from './core-logic.mjs';
const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONCE = args.includes('--once') || DRY_RUN;
const taskIdx = args.indexOf('--task');
const TASK_SPEC = taskIdx >= 0 ? args[taskIdx + 1] : null; // 例: "owner/repo issue#22"
const assessIdx = args.indexOf('--assess');
const ASSESS_SPEC = assessIdx >= 0 ? args[assessIdx + 1] : null; // 評価のみ実行
// ---------- config ----------

const configPath = join(ROOT, 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const AUTO_ASSESS = config.autoAssess ?? false;
const ASSESS_MAX_AGE_MS = (config.assessMaxAgeHours ?? 24) * 3600 * 1000;
const POLL_MS = (config.pollIntervalSec ?? 120) * 1000;
// 並行数はフェーズ別に分離: 評価=軽量なので多め、実装=衝突回避で少なめ
const MAX_ASSESS = config.maxConcurrentAssess ?? config.maxConcurrent ?? 1;
const MAX_IMPL = config.maxConcurrentImpl ?? config.maxConcurrent ?? 1;
const MAX_PR = config.maxConcurrentPr ?? MAX_IMPL;
const STALE_MS = (config.staleRunningMinutes ?? 180) * 60 * 1000;
const LABEL = {
  trigger: config.triggerLabel ?? 'devin',
  running: config.runningLabel ?? 'devin:running',
  done: config.doneLabel ?? 'devin:done',
  failed: config.failedLabel ?? 'devin:failed',
  needsReview: config.needsReviewLabel ?? 'devin:needs-review',
  rejected: config.rejectedLabel ?? 'devin:rejected',
  implDone: config.implDoneLabel ?? 'AI:impl-done',
};
// `devin` トリガーラベルは廃止（autoTrigger が全課題を対象にするため）。
// 作成するのは状態表示用ラベルのみ
const ALL_LABELS = [LABEL.running, LABEL.done, LABEL.failed, LABEL.needsReview, LABEL.rejected, LABEL.implDone];
// ツール実行往復の上限を指示文として全プロンプトへ注入（config.toolMaxSteps, 1-20, 既定10）
const TMS = Math.min(Math.max(+(config.toolMaxSteps ?? 10), 1), 20);
const withTms = (s) => s + `\n\n【ツール往復上限】ツール実行（コマンド・ファイル編集・外部呼び出しの往復）は最大 ${TMS} 回まで。上限に達したらその時点の作業内容と未完了事項をまとめて報告し、処理を終了すること`;
const AUTO_TRIGGER = config.autoTrigger ?? false;
const MAX_NEW_PER_POLL = config.maxNewPerPoll ?? 5;

const LOG_DIR = join(ROOT, 'logs');
const STATE_PATH = join(ROOT, 'state.json');
const CANDS_PATH = join(ROOT, 'candidates.json');
const ISSUES_PATH = join(ROOT, 'issues.json');
mkdirSync(LOG_DIR, { recursive: true });

// ---------- utils ----------

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (msg) => {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  appendFileSync(join(LOG_DIR, 'dispatcher.log'), line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 候補の課題タイトル/URL を state.tasks へ残す。issues.json は発見時の
// 一時ストアで履歴分が消えるため、処理履歴の「何を」表示用に永続化する
const candMeta = (t) => ({ ...(t?.title ? { title: t.title } : {}),
  ...(t?.url ? { url: t.url } : {}) });

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch { return { tasks: {} }; }
}
// control 側（委譲チャット・パネル）が state.json に書く共有フィールドを
// 古いメモリ値で上書きしないよう、書き込み前に state.json の最新値を併合する
// （解除時刻・完了結果のタイムスタンプで最終状態を調停）
function saveState(state) {
  const disk = liveJson(STATE_PATH);
  const out = { ...state, tasks: { ...(disk?.tasks ?? {}) } };
  for (const [k, cur] of Object.entries(state.tasks ?? {})) {
    const dt = out.tasks[k];
    if (!dt || running.has(k)) { out.tasks[k] = cur; continue; }
    const merged = { ...dt, ...cur };
    // control が委譲評価の完了（verdict）・タイムアウトで inflight を解除済みなら
    // メモリ側の滞留マーカーも消す（パネルで engineReq が解除された場合も追従）。
    // メモリ側が先に inflight を delete していてもディスク側の古いマーカーが
    // 併合で復活するため、判定は併合後の値で行う。比較対象は残った inflight の
    // 由来側（cur にあれば cur、なければ dt）の inflightAt とする
    if (merged.inflight) {
      const srcAt = cur.inflight ? cur.inflightAt : dt?.inflightAt;
      if (merged.inflightClearedAt && (!srcAt || merged.inflightClearedAt > srcAt)) {
        delete merged.inflight;
        delete merged.inflightAt;
      }
    }
    // control が委譲 impl の完了を chatResult で確定済みなら委譲マーカーを消す
    if (dt.chatResult && (!cur.delegatedAt || dt.chatResult.at > cur.delegatedAt)) {
      merged.status = dt.chatResult.status ?? merged.status;
      delete merged.chatDelegated;
      delete merged.delegatedAt;
    }
    if (!('engineReq' in dt)) delete merged.engineReq;
    // queued は dispatcher が起動管理用に立てる揮発マーカー（メモリ内キューが正）。
    // メモリ側に無ければディスク側の残存も消す（キュー消化・再起動後の幽霊化防止）
    if (!('queued' in cur)) {
      delete merged.queued; delete merged.queuedAt; delete merged.waitReason;
    }
    out.tasks[k] = merged;
  }
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, STATE_PATH);
}

// ---------- label / comment ops ----------

async function ensureLabels(repo) {
  for (const name of ALL_LABELS) {
    try {
      await gh(['label', 'create', name, '-R', repo, '--force']);
    } catch (e) {
      log(`label create failed: ${repo} ${name}: ${e.message}`);
    }
  }
}

async function setLabel(repo, number, type, add, remove) {
  const a = ['issue', 'edit', String(number), '-R', repo];
  if (type === 'pr') a[0] = 'pr';
  if (add?.length) a.push('--add-label', add.join(','));
  if (remove?.length) a.push('--remove-label', remove.join(','));
  try { await gh(a); }
  catch (e) { log(`label edit failed: ${repo}#${number}: ${e.message}`); }
}

async function comment(repo, number, type, body) {
  try {
    await gh([type === 'pr' ? 'pr' : 'issue', 'comment', String(number), '-R', repo, '--body', body]);
  } catch (e) {
    log(`comment failed: ${repo}#${number}: ${e.message}`);
  }
}

async function closeItem(repo, number, type) {
  try {
    await gh([type === 'pr' ? 'pr' : 'issue', 'close', String(number), '-R', repo]);
  } catch (e) {
    log(`close failed: ${repo}#${number}: ${e.message}`);
  }
}

// ---------- discovery ----------

// 候補の検出は autoTrigger 設定と無関係に常に行う（表示・手動起動用）。
// AUTO_TRIGGER は「検出した候補を自動起動するか」のみを制御する
const findCandidates = (state) =>
  discover({ config, labels: LABEL, state, autoTrigger: true, maxNewPerPoll: MAX_NEW_PER_POLL, log, storePath: ISSUES_PATH });

// 検出した候補を candidates.json に保存（パネル/API がキャッシュとして読む）
function saveCandidates(found) {
  const tmp = CANDS_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    candidates: found.map((t) => toCandidate(t, LABEL)),
  }, null, 2));
  renameSync(tmp, CANDS_PATH);
}


// ---------- runner ----------

const running = new Map(); // key -> { proc, startedAt }
// RISK_RANK / CAT_RANK / VERDICT_STEPS / escalateVerdict は core-logic.mjs へ分離（テスト可能な純粋関数）
const MAX_RISK = () => RISK_RANK[config.maxAutoRisk ?? 'medium'] ?? 1;
const MAX_CAT = () => CAT_RANK.indexOf(config.autoCategory ?? 'review');
// verdict が自動処理範囲を超えたか（引き上げ後の判定に使用）
const verdictOverLimit = (a) => !a || a.category === 'reject'
  || (RISK_RANK[a.risk] ?? 2) > MAX_RISK()
  || CAT_RANK.indexOf(a.category) > MAX_CAT();

const KILL_PATH = join(ROOT, 'kill-requests.json');
const readKillRequests = () => {
  try { return JSON.parse(readFileSync(KILL_PATH, 'utf8')); }
  catch { return { keys: [] }; }
};

function spawnDevin(prompt, task, logPath, key, phase = 'impl') {
  // ACP ランナー経由: devin.exe acp に authenticate(windsurf_api_key) →
  // session/new → session/prompt で実セッションを実行する。
  // （devin.exe -p は CLI ログインが必要だが、ACP は IDE 認証を共有できる）
  return new Promise((resolve) => {
    const promptFile = join(LOG_DIR,
      `prompt_${key.replace(/[^\w#-]/g, '_')}_${Date.now()}.txt`);
    writeFileSync(promptFile, prompt);
    const proc = spawn(process.execPath,
      ['acp-runner.mjs', key, promptFile, logPath], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env },
    });
    // dest（行き先フェーズ: drainQueue の先行登録）は保持したまま更新
    running.set(key, { ...(running.get(key) ?? {}), proc, logPath, startedAt: Date.now(), phase });
    // パネルの「停止」→ kill-requests.json を2秒ごと監視してプロセスを kill
    const iv = setInterval(() => {
      const ks = readKillRequests().keys ?? [];
      if (!ks.includes(key)) return;
      try {
        proc.kill();
        appendFileSync(logPath, `\n[stopped by user via panel]\n`);
        const rest = readKillRequests();
        rest.keys = (rest.keys ?? []).filter((k) => k !== key);
        writeFileSync(KILL_PATH, JSON.stringify(rest));
      } catch { /* noop */ }
    }, 2000);
    const done = (code) => { clearInterval(iv); resolve(code); };
    proc.stdout.on('data', (d) => appendFileSync(logPath, d));
    proc.stderr.on('data', (d) => appendFileSync(logPath, d));
    proc.on('error', (e) => { appendFileSync(logPath, `\n[spawn error] ${e.message}\n`); done(1); });
    // セッションが残した孤児プロセス（検証サーバ・ブラウザ等）が stdio を
    // 握り続けると 'close' は永久に発火せずキューが停止する（実績あり）。
    // セッション終了＝プロセス本体の 'exit' とし、'close' は保険として併用
    proc.on('exit', (code) => done(code ?? 1));
    proc.on('close', (code) => done(code ?? 1));
  });
}

// 評価セッションのログから構造化判定を取り出す
function parseVerdict(logPath) {
  try {
    const text = readFileSync(logPath, 'utf8');
    const blocks = [...text.matchAll(/<!--devin-assess\s*([\s\S]*?)devin-assess-->/g)];
    if (!blocks.length) return null;
    const v = JSON.parse(blocks.at(-1)[1].trim());
    if (!['yes', 'needs-human', 'no'].includes(v.feasible)
      || !['low', 'medium', 'high'].includes(v.risk)) return null;
    let category = v.category;
    if (!['auto', 'review', 'human', 'reject'].includes(category)) {
      // category 未出力の旧形式から推定
      category = v.feasible === 'yes' && v.risk !== 'high' ? 'auto'
        : v.feasible === 'no' || v.risk === 'high' ? 'reject' : 'review';
    }
    return { feasible: v.feasible, risk: v.risk, category,
      partial: v.partial === true || v.partial === 'true',
      scope: v.scope === 'multi' ? 'multi' : 'repo',
      reason: v.reason ?? '', plan: v.plan ?? '' };
  } catch { return null; }
}

// 切り分けセッションのログから <!--split--> ブロックを取り出す
function parseSplitResult(logPath) {
  try {
    const text = readFileSync(logPath, 'utf8');
    const blocks = [...text.matchAll(/<!--split\s*([\s\S]*?)split-->/g)];
    if (!blocks.length) return null;
    const v = JSON.parse(blocks.at(-1)[1].trim());
    return { newKey: v.newKey ?? null, verified: v.verified ?? null };
  } catch { return null; }
}

// ---- 課題単位のエンジン解決（control.mjs resolveEngine と同等の縮約版）----
// 優先順位: issue ラベル/本文の engine 指定 > パネル保存の engineReq
//          > モード別既定(config.engineModes) > config.engine > devin
const ENGINES = ['devin', 'copilot', 'antigravity', 'api'];
const normEngine = (v) => {
  const e = String(v ?? '').trim().toLowerCase();
  return ENGINES.includes(e) ? e : null;
};
// config.json は呼出ごとに読み直す（パネルからのエンジン変更を
// dispatcher 再起動なしで反映するため。liveConfig と同じ方針）
const liveJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
function resolveTaskEngine(key, mode, state) {
  const it = readIssueStore(ISSUES_PATH).issues?.[key];
  if (it) {
    for (const l of it.labels ?? []) {
      const m = String(l).match(/^engine\s*[:：]\s*(\S+)$/i);
      const e = m && normEngine(m[1]);
      if (e) return e;
    }
    const m = String(it.body ?? '').match(/^[ 	>]*engine\s*[:：]\s*([a-zA-Z]+)\s*$/im);
    const e = m && normEngine(m[1]);
    if (e) return e;
  }
  const cfg = liveJson(configPath) ?? config;
  return normEngine(state.tasks[key]?.engineReq)
    ?? normEngine(cfg.engineModes?.[mode])
    ?? normEngine(cfg.engine)
    ?? 'devin';
}

// 非 devin 解決の課題は devin -p を起動せず control のチャット経路
// （/api/chat/task → dispatchChatTask）へ委譲する。
// verdict 記録・評価→対応の連鎖は control 側の watchAssess が担う
async function dispatchViaChat(key, mode, eng) {
  const cfg = liveJson(configPath) ?? config;
  const r = await fetch(`http://127.0.0.1:${cfg.controlPort ?? 8585}/api/chat/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Panel': '1' },
    body: JSON.stringify({ key, mode, engine: eng }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`chat dispatch failed (engine=${eng}): ${j.error || r.status}`);
  log(`CHAT-ROUTE ${key}: engine=${eng} mode=${mode} -> ${JSON.stringify(j)}`);
  return j;
}

// control 側（委譲チャット・パネル）が state.json に書く共有フィールド。
// 各ポーリングでメモリへ追従させないと、委譲完了後も古い inflight が残って
// 課題が永久にスキップされる（running 管理下の課題は dispatcher が正）
// inflight/chatDelegated 系は control 側のチャット経路（評価の自動連鎖・
// パネル操作・MCP キュー）が立てる飛行/委譲マーカーで、二重起動防止に使う
const SHARED_PULL = ['assess', 'assessedAt', 'splitTo', 'splitAt',
  'createdPr', 'prAt', 'closedAt', 'engineReq', 'inflightClearedAt',
  'chatResult', 'engineUsed', 'engineUsedAt',
  'inflight', 'inflightAt', 'chatDelegated', 'delegatedAt', 'chatId'];
// ディスク側で消えたらメモリ側も消すマーカーフィールド
// （control 側が解除・巻き戻しした委譲を幽霊化させない）
const SHARED_PULL_DELETE = new Set(['engineReq', 'inflight', 'inflightAt',
  'chatDelegated', 'delegatedAt', 'chatId']);
async function syncShared(state) {
  const disk = liveJson(STATE_PATH);
  if (!disk?.tasks) return;
  for (const [k, dt] of Object.entries(disk.tasks)) {
    if (running.has(k)) continue;
    const cur = state.tasks[k];
    if (!cur) { state.tasks[k] = dt; continue; }
    // 完了済み委譲（chatResult が delegatedAt より新しい）のマーカーは
    // ディスクから復活させない。復活させると chatResult 消費（status 確定・
    // verdict 引き上げ・ラベル適用）が毎サイクル再実行されてしまう。
    // メモリ側に残る委譲マーカーはこの後の chatResult 消費が始末するため触らない
    const delegDone = dt.chatResult && (!dt.delegatedAt || dt.chatResult.at > dt.delegatedAt);
    for (const f of SHARED_PULL) {
      if (f in dt) {
        if (delegDone && !(f in cur) &&
            (f === 'chatDelegated' || f === 'delegatedAt' || f === 'chatId')) continue;
        cur[f] = dt[f];
      } else if (SHARED_PULL_DELETE.has(f)) delete cur[f];
    }
    if (cur.inflight && dt.inflightClearedAt &&
        (!cur.inflightAt || dt.inflightClearedAt > cur.inflightAt)) {
      delete cur.inflight;
      delete cur.inflightAt;
    }
    if (cur.chatDelegated && dt.chatResult &&
        (!cur.delegatedAt || dt.chatResult.at > cur.delegatedAt)) {
      cur.status = dt.chatResult.status ?? cur.status;
      delete cur.chatDelegated;
      delete cur.delegatedAt;
      // 委譲完了時は devin 経路と同じラベル付与を行う
      // （control は state.json しか書かず GitHub ラベルは操作しない）
      const m2 = k.match(/^(\S+)\s+(issue|pr)#(\d+)$/);
      const rst = dt.chatResult.status;
      let add = rst === 'done' ? [LABEL.done]
        : rst === 'impl-done' ? [LABEL.implDone]
        : rst === 'needs-review' ? [LABEL.needsReview] : [];
      // 委譲 verify の NG 差し戻しでも devin 経路と同様に verdict を1ランク引き上げる。
      // 引き上げ後に自動処理範囲外なら滞留させず needs-review / rejected で終了させる
      // （チャット経路は新 verdict なしに impl へ再投入しないため、ここで確定する）
      if (rst === 'verify-ng' && cur.assess && !cur.assess.error) {
        const before = `${cur.assess.category}/${cur.assess.risk}`;
        cur.assess = escalateVerdict(cur.assess, '再検証 NG（委譲セッション）');
        log(`ESCALATE ${k}: ${before} -> ${cur.assess.category}/${cur.assess.risk}`);
        if (verdictOverLimit(cur.assess)) {
          cur.status = (cur.assess.category === 'reject'
            || (RISK_RANK[cur.assess.risk] ?? 2) > MAX_RISK()) ? 'rejected' : 'needs-review';
          add = [cur.status === 'rejected' ? LABEL.rejected : LABEL.needsReview];
          if (m2) await comment(m2[1], +m2[3], m2[2],
            `再検証 NG による差し戻しで判定ランクが引き上げられ、自動処理範囲を超えました。\n\n` +
            `- category: \`${cur.assess.category}\` / risk: \`${cur.assess.risk}\`\n` +
            `- 理由: ${cur.assess.reason}\n\n` +
            `人間が対応する場合はラベルを外すか、パネルの「対応」ボタンで直接起動してください。`);
        }
      }
      if (m2) await setLabel(m2[1], +m2[3], m2[2], add,
        [LABEL.running, LABEL.failed]);
      if (m2 && cur.status === 'rejected') await closeItem(m2[1], +m2[3], m2[2]);
    }
    // 委譲の完了通知が失われた場合に備え、古い inflight マーカーは期限切れにする。
    // inflightAt 無しのマーカーはプロセス死亡で取り残された残骸なので即座に期限切れとする
    if (cur.inflight &&
        (!cur.inflightAt || Date.now() - new Date(cur.inflightAt).getTime() > STALE_MS)) {
      delete cur.inflight;
      delete cur.inflightAt;
    }
    // control 側の巻き戻し（起動不能・送信失敗・委譲完了）で running が解除済み
    // ならメモリ側の滞留 status も消す。status は SHARED_PULL 対象外（dispatcher が
    // 正）のため、ディスクの inflightClearedAt が startedAt より新しい場合のみ照合する
    if (cur.status === 'running' && !cur.chatDelegated && !dt.chatDelegated &&
        dt.inflightClearedAt &&
        (!cur.startedAt || dt.inflightClearedAt > cur.startedAt)) {
      delete cur.status;
      delete cur.startedAt;
    }
    if (dt.status === 'closed' && !cur.chatDelegated) cur.status = 'closed';
  }
}

// 委譲チャット課題への停止要求（kill-requests.json）は devin 経路の
// spawnDevin では消費されないため、ここで /api/chat/cancel へ転送する。
// chatId は dispatchChatTask の応答から runTask が state へ記録したもの
async function handleDelegatedKills(state) {
  const kr = readKillRequests();
  if (!kr.keys?.length) return;
  const cfg = liveJson(configPath) ?? config;
  const base = `http://127.0.0.1:${cfg.controlPort ?? 8585}`;
  let dirty = false;
  for (const key of [...kr.keys]) {
    const t = state.tasks[key];
    if (!t?.chatId) continue; // devin 経路は spawnDevin 側が消費・委譲外は対象外
    try {
      await fetch(base + '/api/chat/cancel', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Panel': '1' },
        body: JSON.stringify({ id: t.chatId }) });
    } catch { continue; } // control 未起動時は次サイクルで再試行
    kr.keys = kr.keys.filter((x) => x !== key); dirty = true;
    delete t.chatId; delete t.inflight; delete t.inflightAt;
    if (t.chatDelegated) {
      delete t.chatDelegated; delete t.delegatedAt;
      t.status = 'failed'; t.note = 'ユーザー停止（委譲チャット取消）';
      t.finishedAt = new Date().toISOString();
      const m = key.match(/^(\S+)\s+(issue|pr)#(\d+)$/);
      if (m) await setLabel(m[1], +m[3], m[2], [LABEL.failed], [LABEL.running]);
    }
    log(`delegated chat cancelled by user: ${key}`);
  }
  if (dirty) try { writeFileSync(KILL_PATH, JSON.stringify(kr)); } catch { /* noop */ }
}

async function runTask(task, state, { skipAssess = false } = {}) {
  const key = keyOf(task.repo.github, task.type, task.number);
  // キュー滞留中に close された課題は起動しない。/api/close・GitHub 上の
  // 直接 close はメモリ内キュー要素を除去しないため、起動時に open 状態を
  // 再確認する（verify は closed 課題のコミット掃除を担うので対象外）
  if (task.type === 'issue' && !task.verify) {
    let closed = state.tasks[key]?.status === 'closed';
    if (!closed) {
      try {
        const cur = await ghJson(['issue', 'view', String(task.number),
          '-R', task.repo.github, '--json', 'state']);
        closed = cur.state === 'CLOSED';
      } catch { /* 判定不能なら続行（gh 一時障害で起動を止めない） */ }
    }
    if (closed) {
      state.tasks[key] = { ...(state.tasks[key] ?? {}), status: 'closed', phase: null,
        closedAt: state.tasks[key]?.closedAt ?? new Date().toISOString() };
      delete state.tasks[key].queued; delete state.tasks[key].queuedAt;
      delete state.tasks[key].waitReason;
      saveState(state);
      log(`SKIP ${key}: issue closed`);
      return;
    }
  }
  // control 側のチャット経路（評価の自動連鎖・パネル操作・MCP キュー）が
  // 先行して委譲/実行中の課題は二重起動しない。手動 dispatch（skipAssess）は
  // 人間の明示操作としてこのガードを通す
  if (!skipAssess) {
    const cur0 = state.tasks[key] ?? {};
    if (cur0.inflight || cur0.chatDelegated) {
      log(`SKIP ${key}: delegated chat run in flight`);
      return;
    }
  }
  // 再検証課題（AI:impl-done 付き）は評価・実装を通さず verify モードで処理する
  const mode = task.verify ? 'pr' : (skipAssess ? 'impl' : 'assess');
  const eng = resolveTaskEngine(key, mode, state);
  if (eng !== 'devin') {
    const cur = state.tasks[key] ?? {};
    const verdictFresh = cur.assess?.category && cur.assessedAt
      && Date.now() - new Date(cur.assessedAt).getTime() <= ASSESS_MAX_AGE_MS;
    // verify-ng 差し戻し直後の再候補: 引き上げ済み verdict が自動範囲内なら
    // impl へ再投入する。watchAssess の impl 連鎖は新 verdict 記録時にのみ
    // 発火するため、「判定済みスキップ」のままだと差し戻し課題が滞留する
    const verifyNgRetry = !task.verify && !skipAssess
      && cur.status === 'verify-ng' && verdictFresh
      && !cur.inflight && !cur.chatDelegated
      && !verdictOverLimit(cur.assess);
    // 委譲が飛行中、または判定済み（impl 連鎖は control 側 watchAssess が担う）
    // なら二重送信しない
    if (!verifyNgRetry &&
        (cur.inflight || cur.chatDelegated || (!skipAssess && !task.verify && verdictFresh))) {
      log(`CHAT-ROUTE-SKIP ${key}: delegated in flight or verdict recorded`);
      return;
    }
    const dmode = verifyNgRetry ? 'impl' : mode;
    // 再投入は impl 用エンジンで解決し直す（assess 用と異なる場合がある）。
    // impl エンジンが devin 解決なら委譲せず、このまま devin 経路へ継続する
    // （評価フェーズで引き上げ済み verdict が再利用され impl へ進む）
    const deng = verifyNgRetry ? resolveTaskEngine(key, 'impl', state) : eng;
    if (deng === 'devin') {
      log(`CHAT-ROUTE-RETRY ${key}: impl エンジンは devin 解決のため devin 経路へ継続`);
    } else {
      const j = await dispatchViaChat(key, dmode, deng);
      const now = new Date().toISOString();
      // assess 委譲: verdict 記録・impl 連鎖は watchAssess が担う。status='running'
      // にすると自動連鎖条件（status が running 系でないこと）を塞ぐため
      // inflight マーカーのみ立てる
      // impl/verify 委譲: chat 完了時に control 側 watchImpl が chatResult で
      // status を確定するまで running 表示を維持。chatId は停止要求
      // （kill-requests → /api/chat/cancel）用に記録する
      state.tasks[key] = { ...cur, ...candMeta(task),
        inflight: dmode, inflightAt: now, engineUsed: deng,
        ...(j?.id != null ? { chatId: j.id } : {}),
        note: `エンジン ${deng} のためチャット経路へ委譲(${dmode})`,
        ...(dmode !== 'assess'
          ? { status: 'running', chatDelegated: dmode === 'pr' ? 'verify' : 'impl',
              delegatedAt: now, startedAt: now }
          : {}) };
      saveState(state);
      if (dmode !== 'assess') {
        // devin 経路と同じ running ラベルを付与（完了時の done/failed 等は
        // syncShared が chatResult 消費時に適用、stale 回収は reclaimStale が担う）
        await setLabel(task.repo.github, task.number, task.type,
          [LABEL.running], [LABEL.failed, LABEL.done, LABEL.needsReview, LABEL.rejected]);
      }
      return;
    }
  }
  const base = join(LOG_DIR,
    `${task.repo.github.replace('/', '_')}_${task.type}${task.number}_${Date.now()}`);
  log(`START ${key}`);
  await setLabel(task.repo.github, task.number, task.type,
    [LABEL.running], [LABEL.failed, LABEL.done, LABEL.needsReview, LABEL.rejected]);
  await comment(task.repo.github, task.number, task.type,
    `Devin エージェントが起動しました。完了時に結果を報告します。`);

  running.set(key, { proc: null, logPath: base, startedAt: Date.now(),
    phase: task.verify ? 'verify' : 'assess', dest: task.verify ? 'verify' : 'impl' });
  // スプレッド保持: パネル保存の engineReq 等を消さない
  state.tasks[key] = { ...(state.tasks[key] ?? {}), ...candMeta(task),
    status: 'running', phase: task.verify ? 'verify' : 'assess', startedAt: new Date().toISOString() };
  saveState(state);

  try {
    // ---- 再検証（AI:impl-done 課題の PR処理: 検証→push/差し戻し）----
    if (task.verify) {
      const vp = base + '_verify.log';
      const tries = (state.tasks[key]?.verifyTries ?? 0) + 1;
      const vMax = config.verifyLoopMax ?? 3;
      state.tasks[key] = { ...state.tasks[key], phase: 'verify', verifyTries: tries };
      saveState(state);
      const vprompt = buildTaskPrompt({ ROOT,
        config: liveJson(configPath) ?? config, task, mode: 'verify' });
      log(`VERIFY ${key} -> ${vp} (try ${tries}/${vMax})`);
      const vcode = await spawnDevin(withTms(vprompt), task, vp, key);
      // 結果を issue の状態で確定する: close=反映済み / flag残=未完(再検証) / flag除去=差し戻し
      let st2 = 'needs-review';
      let ngNote = '';
      if (vcode === 0) {
        try {
          const cur = await ghJson(['issue', 'view', String(task.number), '-R', task.repo.github,
            '--json', 'state,labels,comments']);
          const names2 = (cur.labels ?? []).map((l) => l.name ?? l);
          if (cur.state === 'CLOSED') st2 = 'done';
          else if (names2.includes(LABEL.implDone)) st2 = tries >= vMax ? 'needs-review' : 'impl-done';
          else {
            st2 = 'verify-ng';
            // 差し戻し理由は検証セッションが残した最終コメントから引き継ぐ
            ngNote = (cur.comments ?? []).at(-1)?.body?.split('\n')[0].slice(0, 160) ?? '';
          }
        } catch { st2 = 'needs-review'; }
      } else st2 = tries >= vMax ? 'needs-review' : 'failed';
      // verify NG で差し戻された課題は保存済み verdict の category/risk を
      // 1ランク引き上げて再候補化（同一判定での無限再試行を防ぐ）
      const prevAssess = state.tasks[key]?.assess;
      const escalated = st2 === 'verify-ng' && prevAssess && !prevAssess.error
        ? escalateVerdict(prevAssess, ngNote || `再検証 NG（try ${tries}）`)
        : null;
      if (escalated) {
        log(`ESCALATE ${key}: ${prevAssess.category}/${prevAssess.risk} -> ${escalated.category}/${escalated.risk}`);
      }
      state.tasks[key] = { ...state.tasks[key], verifyLog: vp, phase: null,
        ...(escalated ? { assess: escalated } : {}),
        status: st2, finishedAt: new Date().toISOString(), exitCode: vcode };
      saveState(state);
      log(`VERIFY-${st2.toUpperCase()} ${key} (exit ${vcode})`);
      // needs-review（vMax 到達・結果確定不能）は自動再検証を諦める終端。
      // implDone を残すと discover が verify 候補へ戻して試行上限を迂回する
      // （failed ＜ vMax は implDone 維持で次ポーリングに自動再試行させる）
      await setLabel(task.repo.github, task.number, task.type,
        st2 === 'failed' ? [LABEL.failed] : st2 === 'needs-review' ? [LABEL.needsReview] : [],
        st2 === 'needs-review' ? [LABEL.running, LABEL.implDone] : [LABEL.running]);
      if (st2 === 'failed') await comment(task.repo.github, task.number, task.type,
        `再検証セッションが異常終了しました（exit ${vcode}）。ログ: \`${vp}\`\n\n再試行はパネルの「再実行」ボタンまたは \`POST /api/dispatch\` から行えます。`);
      if (st2 === 'needs-review') await comment(task.repo.github, task.number, task.type,
        `再検証が ${vMax} 回試行しても完了しませんでした。人間の確認が必要です。`);
      if (escalated) await comment(task.repo.github, task.number, task.type,
        `再検証 NG のため差し戻しました。判定ランクを引き上げます: ` +
        `category \`${prevAssess.category}\`→\`${escalated.category}\` / ` +
        `risk \`${prevAssess.risk}\`→\`${escalated.risk}\`。課題は再対応キューへ戻ります。`);
      return;
    }

    // ---- Phase 1: 評価 ----
    if (!skipAssess && config.assessFirst !== false) {
      // 検出時評価などで既に新鮮な判定があれば再利用（二重評価を防止）
      const stored = state.tasks[key];
      const fresh = stored?.assess && !stored.assess.error && stored.assessedAt
        && Date.now() - new Date(stored.assessedAt).getTime() < ASSESS_MAX_AGE_MS;
      let verdict, code = 0, ap = stored?.assessLog;
      if (fresh) {
        verdict = stored.assess;
        log(`ASSESS-REUSE ${key}: ${verdict.category}/${verdict.risk}`);
      } else {
        ap = base + '_assess.log';
        log(`ASSESS ${key} -> ${ap}`);
        code = await spawnDevin(withTms(buildTaskPrompt({ ROOT,
          config: liveJson(configPath) ?? config, task, mode: 'assess' })),
          task, ap, key, 'assess');
        verdict = code === 0 ? parseVerdict(ap) : null;
        state.tasks[key] = { ...state.tasks[key], assessLog: ap,
          assess: verdict ?? { error: `exit ${code} or unparsed` },
          assessedAt: new Date().toISOString() };
        saveState(state);
      }

      const tooRisky = verdict && (RISK_RANK[verdict.risk] ?? 2) > MAX_RISK();
      const reject = code !== 0 || !verdict || verdict.category === 'reject' || tooRisky;
      const proceed = !reject &&
        CAT_RANK.indexOf(verdict.category) <= MAX_CAT();
      if (reject) {
        // reject: 破壊的影響・方針違反・評価不能など。実施せず恒久的に除外
        const why = verdict
          ? `category=reject, feasible=${verdict.feasible}, risk=${verdict.risk} — ${verdict.reason}`
          : `評価セッション異常終了（exit ${code}）または判定出力なし`;
        log(`REJECTED ${key}: ${why}`);
        state.tasks[key] = { ...state.tasks[key], status: 'rejected', finishedAt: new Date().toISOString() };
        saveState(state);
        await setLabel(task.repo.github, task.number, task.type,
          [LABEL.rejected], [LABEL.running]);
        await comment(task.repo.github, task.number, task.type,
          `**事前評価の結果、自動対応しないと判定しました（reject）。**\n\n` +
          `- feasible: \`${verdict?.feasible ?? 'unknown'}\` / risk: \`${verdict?.risk ?? 'unknown'}\`\n` +
          `- 理由: ${verdict?.reason ?? why}\n` +
          `- 評価ログ: \`${ap}\`\n\n` +
          `この課題は \`${LABEL.rejected}\` ラベル付きでクローズされ、今後の自動処理から除外されます。` +
          `人間が対応する場合は issue を再オープンするか、パネルの「対応」ボタンで直接起動してください。`);
        await closeItem(task.repo.github, task.number, task.type);
        return;
      }
      if (!proceed) {
        const why = `category=${verdict.category}, feasible=${verdict.feasible}, risk=${verdict.risk} — ${verdict.reason}`;
        log(`NEEDS-REVIEW ${key}: ${why}`);
        state.tasks[key] = { ...state.tasks[key], status: 'needs-review', finishedAt: new Date().toISOString() };
        saveState(state);
        await setLabel(task.repo.github, task.number, task.type,
          [LABEL.needsReview], [LABEL.running]);
        await comment(task.repo.github, task.number, task.type,
          `**事前評価の結果、人間の検討が必要と判定しました（review）。**\n\n` +
          `- feasible: \`${verdict.feasible}\` / risk: \`${verdict.risk}\`\n` +
          `- 理由: ${verdict.reason}\n${verdict.plan ? `- 方針案: ${verdict.plan}\n` : ''}` +
          `- 評価ログ: \`${ap}\`\n\n` +
          `人間が確認して対応する場合は \`${LABEL.needsReview}\` ラベルを外すか、パネルの「対応」ボタンで直接起動してください。`);
        return;
      }
      // ---- 一部実装済み（partial=true）: 切り分けセッション ----
      // 実装済み部分の検証 OK → 元 issue クローズ＋残作業は [残課題] 新 issue が
      // 引き継ぐ（新 issue は検出されて同じフローを回る＝再帰）。NG・未クローズは
      // 「課題に戻す」として通常の実装へ継続。splitAt で多重切り分けを防ぐ
      if ((verdict.partial === true || verdict.partial === 'true')
          && !state.tasks[key]?.splitAt) {
        const sp = base + '_split.log';
        log(`SPLIT ${key} -> ${sp}`);
        state.tasks[key] = { ...state.tasks[key], phase: 'split' };
        saveState(state);
        const scode = await spawnDevin(withTms(buildTaskPrompt({ ROOT,
          config: liveJson(configPath) ?? config, task, mode: 'split' })),
          task, sp, key, 'split');
        const sres = parseSplitResult(sp);
        let closed = false;
        try {
          const cur = await ghJson(['issue', 'view', String(task.number),
            '-R', task.repo.github, '--json', 'state']);
          closed = cur.state === 'CLOSED';
        } catch { /* 判定不能なら課題継続 */ }
        state.tasks[key] = { ...state.tasks[key], splitLog: sp,
          splitAt: new Date().toISOString(),
          ...(sres?.newKey ? { splitTo: sres.newKey } : {}) };
        if (scode === 0 && closed) {
          state.tasks[key] = { ...state.tasks[key], status: 'done', phase: null,
            note: `切り分け完了${sres?.newKey ? '（残作業 → ' + sres.newKey + '）' : ''}`,
            finishedAt: new Date().toISOString() };
          saveState(state);
          log(`SPLIT-DONE ${key}${sres?.newKey ? ' -> ' + sres.newKey : ''}`);
          await setLabel(task.repo.github, task.number, task.type, [], [LABEL.running]);
          return;
        }
        saveState(state);
        log(`SPLIT-NG ${key} (exit ${scode}): 課題は継続（実装へ）`);
      }
      await comment(task.repo.github, task.number, task.type,
        `**事前評価 OK** — feasible=yes, risk=${verdict.risk}\n\n方針: ${verdict.plan}\n\n実装セッションを開始します。`);
      log(`ASSESS-OK ${key}: ${verdict.plan}`);
    }

    // ---- Phase 2: 実装 ----
    state.tasks[key] = { ...state.tasks[key], phase: 'impl' };
    saveState(state);
    const ip = base + '_impl.log';
    const pcfg = liveJson(configPath) ?? config;
    const prompt = buildTaskPrompt({ ROOT, config: pcfg, task, mode: 'impl',
      implLoopMax: pcfg.implLoopMax ?? 5 });
    log(`IMPL ${key} -> ${ip}`);
    const code = await spawnDevin(withTms(prompt), task, ip, key);
    const ok = code === 0;
    // issue 実装の成功 = ローカルコミット＋AI:impl-done 付与済み。
    // フラグが立っていない完了は未検証として needs-review で人間確認へ回す
    let flagged = task.type !== 'issue';
    let closed = false;
    if (ok && task.type === 'issue') {
      try {
        const cur = await ghJson(['issue', 'view', String(task.number), '-R', task.repo.github,
          '--json', 'state,labels']);
        flagged = (cur.labels ?? []).some((l) => (l.name ?? l) === LABEL.implDone);
        closed = cur.state === 'CLOSED';
      } catch { flagged = false; }
    }
    // 対応困難でエージェントがクローズした課題は終端扱い（needs-review へ回さない）
    const post = !ok ? 'failed'
      : closed ? 'closed'
      : task.type === 'issue' ? (flagged ? 'impl-done' : 'needs-review')
      : 'done';
    state.tasks[key] = { ...state.tasks[key], implLog: ip, phase: null,
      status: post, finishedAt: new Date().toISOString(), exitCode: code };
    saveState(state);
    log(`${!ok ? 'FAIL' : post === 'impl-done' ? 'IMPL-DONE' : post.toUpperCase()} ${key} (exit ${code})`);
    await setLabel(task.repo.github, task.number, task.type,
      post === 'impl-done' ? [LABEL.implDone]
        : post === 'needs-review' ? [LABEL.needsReview]
        : post === 'done' ? [LABEL.done]
        : post === 'closed' ? [] : [LABEL.failed],
      post === 'failed' || post === 'closed' ? [LABEL.running, LABEL.implDone] : [LABEL.running]);
    await comment(task.repo.github, task.number, task.type,
      ok
        ? `Devin セッションが完了しました。ログ: \`${ip}\`\n\n` +
          (post === 'impl-done'
            ? `処理済みフラグ（${LABEL.implDone}）を確認しました。続けて再検証（PR処理）へ進みます。`
            : post === 'needs-review'
              ? `完了と報告されましたが処理済みフラグ（${LABEL.implDone}）が確認できませんでした。人間の確認が必要です。`
              : post === 'closed'
                ? `課題はクローズ済みです（対応困難として終了）。`
                : `最終報告はセッションログの末尾を参照してください。`)
        : `Devin セッションが異常終了しました（exit ${code}）。ログ: \`${ip}\`\n\n再試行はパネルの「再実行」ボタンまたは \`POST /api/dispatch\` から行えます。`);
  } catch (e) {
    // 予期しない例外（コード不具合・外部コマンド失敗等）で中断した課題を
    // status='running' のまま残さない。stale 回収と同じ failed 終端へ寄せる
    log(`runTask error ${key}: ${e.message}`);
    state.tasks[key] = { ...(state.tasks[key] ?? {}), status: 'failed', phase: null,
      note: `runTask 中断: ${e.message}`, finishedAt: new Date().toISOString() };
    saveState(state);
    await setLabel(task.repo.github, task.number, task.type,
      [LABEL.failed], [LABEL.running]);
    await comment(task.repo.github, task.number, task.type,
      `Devin セッションが内部エラーで中断しました（${e.message}）。` +
      `再試行はパネルの「再実行」ボタンまたは \`POST /api/dispatch\` から行えます。`);
  } finally {
    running.delete(key);
    drainQueue(state);
  }
}

// 既定ブランチの未 push コミット数（取得失敗時は 0 扱い=ゲートしない）
function unpushedCommits(repoPath) {
  try {
    const br = execFileSync('git', ['-C', repoPath, 'branch', '--show-current'],
      { encoding: 'utf8', timeout: 10000 }).trim() || 'main';
    return +execFileSync('git', ['-C', repoPath, 'rev-list', '--count', `origin/${br}..HEAD`],
      { encoding: 'utf8', timeout: 10000 }).trim() || 0;
  } catch { return 0; }
}

// 未 push コミットの帰属課題番号を最古->最新の順で返す（(#N) と Issue: #N トレーラー双方を解釈）
function unpushedIssueOrder(repoPath) {
  try {
    const br = execFileSync('git', ['-C', repoPath, 'branch', '--show-current'],
      { encoding: 'utf8', timeout: 10000 }).trim() || 'main';
    const out = execFileSync('git', ['-C', repoPath, 'log', '--reverse',
      '--format=%B%x00', 'origin/' + br + '..HEAD'],
      { encoding: 'utf8', timeout: 10000 });
    const order = new Map();
    for (const msg of out.split(String.fromCharCode(0))) {
      const n = parseIssueRef(msg);
      if (n != null && !order.has(n)) order.set(n, order.size);
    }
    return order;
  } catch { return new Map(); }
}

const queue = [];
let draining = false;
// 再判定ループの不死性を保証するラッパー。本体（drainQueueBody）内の例外
// （saveState 書込競合・ゲート判定の予期しない throw 等）で draining が
// true 固着すると以後全呼出が早期 return してキューが無言で永久停止する
// （実績あり）。必ずフラグを戻し、例外はログへ残して次サイクルへ委ねる
function drainQueue(state) {
  if (draining) return;
  draining = true;
  try {
    drainQueueBody(state);
  } catch (e) {
    log(`drainQueue error: ${e.message}`);
  } finally {
    draining = false;
  }
}
function drainQueueBody(state) {
  // 起動可能なタスクを全て起動して抜ける（await しない）。
  // 各タスクの完了時に再度 drainQueue が呼ばれ、空いた枠で次が起動される
  // キュー滞留中に close された課題を除去（closed は終端で再判定の対象外。
  // state.tasks.status は /api/close・syncShared の gh 実状態で更新される。
  // verify は closed 課題のコミット掃除を担うため残す）
  let purged = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    const q = queue[i];
    if (q.verify) continue;
    const k = keyOf(q.repo.github, q.type, q.number);
    if (state.tasks[k]?.status !== 'closed') continue;
    queue.splice(i, 1);
    if (state.tasks[k]?.queued || state.tasks[k]?.waitReason) {
      state.tasks[k] = { ...state.tasks[k] };
      delete state.tasks[k].queued; delete state.tasks[k].queuedAt;
      delete state.tasks[k].waitReason;
      purged = true;
    }
    log(`dequeue ${k}: issue closed`);
  }
  if (purged) saveState(state);
  const ordCache = new Map(); // verify 優先順位用: repo -> Map(issue番号->順位)
  // 起動不可の理由を返す（起動可なら null）。滞留タスクへ理由を記録して
  // 「同時起動がないのに待機」に見える状態を説明可能にする
  const blockedReason = (t) => {
    const dest = t.verify ? 'verify' : t.assessOnly ? 'assess' : 'impl';
    const isPr = dest === 'impl' && t.type === 'pr';
    // 同時起動数はフェーズ別（パネル変更を即時反映するため都度 config を読む）
    const base = liveConfig('maxConcurrent', config.maxConcurrent ?? 1);
    // 0 以下の設定値はキュー永久滞留になるため 1 に丸める
    const max = Math.max(1, dest === 'assess'
      ? liveConfig('maxConcurrentAssess', base)
      : (dest === 'verify' || isPr)
        ? liveConfig('maxConcurrentPr', liveConfig('maxConcurrentImpl', base))
        : liveConfig('maxConcurrentImpl', base));
    // 同時起動数はリポジトリ毎に数える（issue#70）。ただし評価で影響範囲が
    // 複数リポジトリ横断（scope=multi）と判定された impl 課題は、作業ツリー
    // 衝突回避のため全リポジトリ合算で上限を適用する
    const tKey = keyOf(t.repo.github, t.type, t.number);
    const globalScope = dest === 'impl' && t.type === 'issue'
      && state.tasks[tKey]?.assess?.scope === 'multi';
    // dest（行き先フェーズ）で数える: impl 予定のタスクは評価中でも impl 枠を占有し、
    // 評価通過後に上限を超えて impl へ進まないようにする
    const busy = [...running.entries()].filter(([k, v]) =>
      v.dest === dest &&
      (globalScope || k.startsWith(t.repo.github + ' ')) &&
      (dest === 'assess' || k.includes(isPr ? ' pr#' : ' issue#'))).length;
    if (busy >= max) return 'concurrency';
    // 同一リポジトリの書き込み系（impl=ローカルコミット / verify=push・reset）は
    // 同じ作業ツリーで衝突するため直列化
    const repoBusy = (dest === 'impl' || dest === 'verify') && [...running.entries()]
      .some(([k, v]) => (v.dest === 'impl' || v.dest === 'verify')
        && k.startsWith(t.repo.github + ' '));
    if (repoBusy) return 'repo-serial';
    // 未 push コミット（= 未検証の実装）が残るリポジトリでは新規実装を開始しない。
    // 別課題の未検証コミットが再検証の push に巻き込まれるのを防ぐ
    const gated = dest === 'impl' && t.type === 'issue' && unpushedCommits(t.repo.path) > 0;
    return gated ? 'unpushed' : null;
  };
  for (;;) {
    let idx = queue.findIndex((t) => !blockedReason(t));
    // 同リポジトリの verify が複数起動可能なら未 push コミットの最古帰属を優先
    // （未検証コミットが他課題 verify の push に同乗する機会を減らす）
    if (idx >= 0 && queue[idx].verify) {
      const ordOf = (t) => {
        if (!ordCache.has(t.repo.github))
          ordCache.set(t.repo.github, unpushedIssueOrder(t.repo.path));
        const m = ordCache.get(t.repo.github);
        return m.has(t.number) ? m.get(t.number) : 1e9;
      };
      for (let k = idx + 1; k < queue.length; k++) {
        const q = queue[k];
        if (q.verify && q.repo.github === queue[idx].repo.github &&
            !blockedReason(q) && ordOf(q) < ordOf(queue[idx])) idx = k;
      }
    }
    if (idx < 0) break;
    const task = queue.splice(idx, 1)[0];
    const key = keyOf(task.repo.github, task.type, task.number);
    // キュー待ちマーカーを解除（runTask が task エントリを spread 更新する前に
    // 消さないと実行中エントリへ queued が残ってしまう）
    if (state.tasks[key]?.queued || state.tasks[key]?.waitReason) {
      delete state.tasks[key].queued; delete state.tasks[key].queuedAt;
      delete state.tasks[key].waitReason;
      saveState(state);
    }
    // running.set は runTask/doAssess 内で非同期に行われるため、ここで先行登録して
    // 続く findIndex の busy/repoBusy 判定へ即時反映する
    running.set(key, { proc: null, logPath: null,
      startedAt: Date.now(), phase: task.verify ? 'verify' : 'assess',
      dest: task.verify ? 'verify' : task.assessOnly ? 'assess' : 'impl' });
    (task.assessOnly ? doAssess(task, state) : runTask(task, state))
      .catch((e) => log(`runTask error ${key}: ${e.message}`))
      .finally(() => { running.delete(key); drainQueue(state); });
  }
  // 起動できず滞留しているタスクへ待機理由を記録する
  // （/api/candidates 経由でパネルの「待機中」表示に理由を出すため。
  // 理由が消えた＝起動条件を満たした滞留は次回 findIndex で起動される）
  let wq = false;
  for (const q of queue) {
    const k = keyOf(q.repo.github, q.type, q.number);
    const rsn = blockedReason(q);
    if ((state.tasks[k]?.waitReason ?? null) !== rsn) {
      state.tasks[k] = { ...(state.tasks[k] ?? {}), waitReason: rsn };
      wq = true;
    }
  }
  if (wq) saveState(state);
}

// ---------- reclaim stale ----------

async function reclaimStale(state) {
  // devin:running ラベルが残っているが、本プロセスが追跡していない＝前回プロセスごと落ちた
  for (const r of config.repos) {
    for (const type of ['issue', 'pr']) {
      let items;
      try {
        items = await ghJson([
          type === 'pr' ? 'pr' : 'issue', 'list', '-R', r.github, '--state', 'open',
          '--label', LABEL.running,
          '--json', 'number,updatedAt',
        ]);
      } catch { continue; }
      for (const it of items) {
        const key = keyOf(r.github, type, it.number);
        if (running.has(key)) continue;
        // 委譲チャット実行中の課題は control 側が追跡するため回収しない
        // （委譲から STALE_MS 超過＝制御喪失とみなし通常の回収対象とする）
        const dk = state.tasks[key];
        if (dk?.chatDelegated && dk.delegatedAt &&
            Date.now() - new Date(dk.delegatedAt).getTime() < STALE_MS) continue;
        const age = Date.now() - new Date(it.updatedAt).getTime();
        if (age < STALE_MS) continue;
        log(`stale running label reclaimed: ${key} (age ${Math.round(age / 60000)}min)`);
        await setLabel(r.github, it.number, type, [LABEL.failed], [LABEL.running]);
        await comment(r.github, it.number, type,
          `前回の Devin セッションが中断しました（dispatcher 停止またはタイムアウト）。再試行はパネルの「再実行」ボタンまたは \`POST /api/dispatch\` から行えます。`);
        state.tasks[key] = { ...(state.tasks[key] ?? {}),
          status: 'failed', note: 'stale running label reclaimed', finishedAt: new Date().toISOString() };
        delete state.tasks[key].chatDelegated;
        delete state.tasks[key].delegatedAt;
        delete state.tasks[key].chatId;
      }
    }
  }
  saveState(state);
}

// ---------- delegated sweep ----------

// 委譲チャット課題の最終回収（セーフティネット）: control 側の watcher が
// 全滅・または control 自体が停止して chatResult が書かれないまま
// delegatedSweepMinutes を超えた委譲は、dispatcher が gh 実状態で終端判定した
// chatResult を立て、syncShared の既存消費経路（status確定・ラベル適用・
// verify-ng エスカレーション）へ載せる。マーカーを直接消さないのは消費経路の
// 一本化のため（二重の状態遷移を防ぐ）
async function sweepDelegatedStale(state) {
  if (DRY_RUN) return;
  const sweepMs = liveConfig('delegatedSweepMinutes', 90) * 60 * 1000;
  const flag = config.implDoneLabel ?? 'AI:impl-done';
  for (const [key, t] of Object.entries(state.tasks ?? {})) {
    if (!isDelegatedStale(t, { staleMs: sweepMs })) continue;
    const m = key.match(/^(\S+)\s+(issue|pr)#(\d+)$/);
    if (!m) continue;
    let status;
    try {
      const cur = await ghJson([m[2], 'view', m[3], '-R', m[1], '--json', 'state,labels']);
      status = resolveDelegatedStatus(t.chatDelegated, {
        state: cur.state,
        labels: (cur.labels ?? []).map((l) => l.name ?? l),
        flag, isPr: m[2] === 'pr' });
    } catch { continue; } // gh 失敗は次サイクルで再試行
    const at = new Date().toISOString();
    state.tasks[key] = { ...t,
      chatResult: { status, at, via: 'delegated-sweep' },
      inflightClearedAt: at };
    delete state.tasks[key].inflight;
    delete state.tasks[key].inflightAt;
    delete state.tasks[key].chatId;
    saveState(state);
    log(`delegated sweep resolved ${key} -> ${status}`);
  }
}

// ---------- orphaned runs ----------

// 前回プロセスが中断した実行中課題を起動時に終端化する。
// running マップは起動直後は空なので、status='running' の残存は全て中断の痕跡。
// phase のみ残った課題（終端処理前に落ちた完了タスク）も掃除する。
// 委譲チャット経路（inflight/chatDelegated）は control 側の回収・watch 系が
// 担うため対象外。stale ラベル（devin:running 残留）は reclaimStale が担う。
async function sweepOrphanedRuns(state) {
  for (const [key, t] of Object.entries(state.tasks ?? {})) {
    if (!t || running.has(key) || t.inflight || t.chatDelegated) continue;
    if (t.status !== 'running') {
      if (t.phase) { delete t.phase; saveState(state); }
      continue;
    }
    const m = key.match(/^(\S+)\s+(issue|pr)#(\d+)$/);
    if (!m) continue;
    let closed = false;
    try {
      const cur = await ghJson([m[2], 'view', m[3], '-R', m[1], '--json', 'state']);
      closed = cur.state === 'CLOSED' || cur.state === 'MERGED';
    } catch { /* 判定不能なら failed 扱い */ }
    const post = closed ? 'done' : 'failed';
    log(`orphaned run reclaimed: ${key} -> ${post}`);
    state.tasks[key] = { ...t, status: post, phase: null,
      note: 'dispatcher 停止により中断', finishedAt: new Date().toISOString() };
    saveState(state);
    await setLabel(m[1], +m[3], m[2],
      [closed ? LABEL.done : LABEL.failed], [LABEL.running]);
    if (!closed) await comment(m[1], +m[3], m[2],
      `前回の Devin セッションが中断しました（dispatcher 停止またはクラッシュ）。` +
      `再試行はパネルの「再実行」ボタンまたは \`POST /api/dispatch\` から行えます。`);
  }
}

// ---------- single task (--task) ----------

async function runSingleTask(spec, state) {
  const m = spec.match(/^(\S+)\s+(issue|pr)#(\d+)$/);
  if (!m) { log(`invalid --task spec: "${spec}" (want "owner/repo issue#N")`); process.exit(1); }
  const [, ghRepo, type, numStr] = m;
  const repo = (config.repos ?? []).find((r) => r.github === ghRepo);
  if (!repo) { log(`repo not in config.repos: ${ghRepo}`); process.exit(1); }
  const key = keyOf(ghRepo, type, numStr);
  // 課題詳細はローカル issue ストアを優先（gh 呼出を削減）。無ければライブ取得
  let it = readIssueStore(ISSUES_PATH).issues?.[key];
  if (it) log(`issue store hit: ${key}`);
  if (!it) {
    it = await ghJson([
      type === 'pr' ? 'pr' : 'issue', 'view', numStr, '-R', ghRepo,
      '--json', 'number,title,body,url,labels,createdAt,updatedAt',
    ]);
  }
  const labels = it.labels.map((l) => l.name ?? l);
  if (labels.includes(LABEL.running)) {
    log(`skip ${key}: already has ${LABEL.running} label`);
    return;
  }
  const task = { ...it, repo, type, labels,
    // AI:impl-done フラグ付き issue は実装ではなく再検証として処理する
    verify: type === 'issue' && labels.includes(LABEL.implDone) };
  await ensureLabels(ghRepo);
  // 手動 dispatch は人間が対象を選定済みのため評価フェーズをスキップ
  await runTask(task, state, { skipAssess: true });
  while (running.size) await sleep(1000);
}

// 評価セッションだけを実行し、判定を state に保存（実装・ラベル操作はしない）
// task = { repo, type, number, title, body, url, labels }
async function doAssess(task, state) {
  const key = keyOf(task.repo.github, task.type, task.number);
  // チャット経路（パネル操作・委譲・自動連鎖・MCP キュー）が先行している
  // 課題は二重評価しない
  const cur0 = state.tasks[key] ?? {};
  if (cur0.inflight || cur0.chatDelegated) {
    log(`ASSESS-SKIP ${key}: delegated chat run in flight`);
    return;
  }
  // 非 devin 解決時はチャット経路へ委譲。verdict は control 側 watchAssess が
  // state.tasks[key].assess へ記録する（委譲中は inflight で多重キューを抑止）
  const eng = resolveTaskEngine(key, 'assess', state);
  if (eng !== 'devin') {
    await dispatchViaChat(key, 'assess', eng);
    state.tasks[key] = { ...(state.tasks[key] ?? {}), ...candMeta(task),
      inflight: 'assess', inflightAt: new Date().toISOString(), engineUsed: eng,
      note: `エンジン ${eng} のためチャット経路へ委譲` };
    saveState(state);
    return;
  }
  const ap = join(LOG_DIR,
    `${task.repo.github.replace('/', '_')}_${task.type}${task.number}_assess_${Date.now()}.log`);
  log(`ASSESS-ONLY ${key} -> ${ap}`);
  running.set(key, { proc: null, logPath: ap, startedAt: Date.now(), phase: 'assess', dest: 'assess' });
  state.tasks[key] = { ...(state.tasks[key] ?? {}), ...candMeta(task),
    inflight: 'assess', inflightAt: new Date().toISOString() };
  saveState(state);
  try {
    const code = await spawnDevin(
      withTms(buildTaskPrompt({ ROOT,
        config: liveJson(configPath) ?? config, task, mode: 'assess' })),
      task, ap, key, 'assess');
    const verdict = code === 0 ? parseVerdict(ap) : null;
    state.tasks[key] = {
      ...(state.tasks[key] ?? {}),
      assess: verdict ?? { error: `exit ${code} or unparsed` },
      assessedAt: new Date().toISOString(),
    };
    saveState(state);
    log(`ASSESS-RESULT ${key}: ${verdict ? `${verdict.category}/${verdict.risk}` : 'unparsed'}`);
  } finally {
    running.delete(key);
    if (state.tasks[key]) {
      delete state.tasks[key].inflight;
      // 解除時刻を残して saveState の併合でディスク側の古い inflight も消す
      state.tasks[key].inflightClearedAt = new Date().toISOString();
      saveState(state);
    }
  }
}

// --assess: CLI からの評価実行
async function runAssess(spec, state) {
  const m = spec.match(/^(\S+)\s+(issue|pr)#(\d+)$/);
  if (!m) { log(`invalid --assess spec: "${spec}"`); process.exit(1); }
  const [, ghRepo, type, numStr] = m;
  const repo = (config.repos ?? []).find((r) => r.github === ghRepo);
  if (!repo) { log(`repo not in config.repos: ${ghRepo}`); process.exit(1); }
  const key = keyOf(ghRepo, type, numStr);
  let it = readIssueStore(ISSUES_PATH).issues?.[key];
  if (!it) {
    it = await ghJson([
      type === 'pr' ? 'pr' : 'issue', 'view', numStr, '-R', ghRepo,
      '--json', 'number,title,body,url,labels,createdAt,updatedAt',
    ]);
  }
  // ストア由来の it.repo は文字列(repo名)。repo オブジェクトで上書きする
  const task = { ...it, repo, type, labels: it.labels.map((l) => l.name ?? l) };
  await doAssess(task, state);
}

// ---------- main loop ----------

// 設定値はサイクルごとに読み直す（パネルからの変更を再起動なしで反映）
function liveConfig(key, fallback) {
  try { return JSON.parse(readFileSync(configPath, 'utf8'))[key] ?? fallback; }
  catch { return fallback; }
}

async function cycle(state) {
  // control 側が進めた委譲タスクの完了・解除を先にメモリへ取り込む
  await syncShared(state);
  // control 側の回収が全滅した委譲課題を gh 実状態で終端化（chatResult 経由）
  await sweepDelegatedStale(state);
  // 委譲チャット課題への停止要求を転送（devin 経路分は spawnDevin が消費）
  await handleDelegatedKills(state);
  // エラー入力の自動取り込み（config.autoIssueOnFailure=true のときのみ）
  if (!DRY_RUN) {
    try {
      await checkFailures({
        config: { ...config,
          autoIssueOnFailure: liveConfig('autoIssueOnFailure', false),
          failureDedupeHours: liveConfig('failureDedupeHours', 24) },
        state, saveState, gh, ghJson, log });
    } catch (e) { log('failure-watch error: ' + e.message); }
  }
  // autoDiscover OFF なら検出自体をスキップ（gh を叩かない・candidates.json も更新しない）
  if (!DRY_RUN && liveConfig('autoDiscover', true) === false) {
    return;
  }
  const found = await findCandidates(state);
  if (DRY_RUN) {
    for (const t of found) {
      const k = keyOf(t.repo.github, t.type, t.number);
      const st = state.tasks[k]?.status ?? 'new';
      const how = t.verify ? 'impl-done' : t.active ? 'active' : (t.auto ? 'auto-new' : 'label');
      const runningLabel = t.labels.includes(LABEL.running) ? ' [running-label]' : '';
      console.log(`${k}  "${t.title}"  trigger=${how}  state=${st}${runningLabel}`);
    }
    console.log(`-- ${found.length} candidate(s)${AUTO_TRIGGER ? '' : ' (autoTrigger OFF: 起動しません)'}`);
    return;
  }
  saveCandidates(found);
  // 初期検出時の自動評価: 未評価 or 判定が古い候補を評価キューへ（表示用。実装はしない）
  if (liveConfig('autoAssess', AUTO_ASSESS)) {
    let qd = false;
    for (const t of found) {
      // active 候補（実行中・待機中の表示維持用）は評価キューへ積まない
      if (t.active) continue;
      const key = keyOf(t.repo.github, t.type, t.number);
      const assessedAt = state.tasks[key]?.assessedAt;
      const stale = !assessedAt
        || Date.now() - new Date(assessedAt).getTime() > ASSESS_MAX_AGE_MS;
      if (!stale) continue;
      if (running.has(key) || queue.some((q) => keyOf(q.repo.github, q.type, q.number) === key)
        || state.tasks[key]?.inflight) continue;
      queue.push({ ...t, assessOnly: true });
      // パネルの「待機中」表示・SSE 即時反映用に state へキュー待ちを記録する
      state.tasks[key] = { ...(state.tasks[key] ?? {}), ...candMeta(t),
        queued: 'assess', queuedAt: new Date().toISOString() };
      qd = true;
      log(`queued assess ${key} "${t.title}"`);
    }
    if (qd) saveState(state);
  }
  // 自動起動の可否も毎サイクル読み直す
  const autoTrigger = liveConfig('autoTrigger', AUTO_TRIGGER);
  if (!autoTrigger) {
    if (found.length) log(`${found.length} candidate(s) detected (autoTrigger OFF: launch skipped)`);
    // autoAssess で積んだ評価キューだけでも起動する（drainQueue は実装キュー到達前に
    // return されると呼ばれず、タスクが滞留する）
    drainQueue(state);
    return;
  }
  for (const t of found) {
    // active 候補（実行中・待機中の表示維持用）は自動起動の対象外。
    // 起動可否は既存の running/inflight/ラベルガードが別途判定する
    if (t.active) continue;
    const key = keyOf(t.repo.github, t.type, t.number);
    // 起票者ゲート: autoTriggerMode=trusted で非信頼 author の課題は自動起動しない
    // （候補一覧には出す。手動 dispatch・devin ラベル経路は別途起動可）
    if (t.autoBlocked) {
      state.tasks[key] = { ...(state.tasks[key] ?? {}), ...candMeta(t),
        autoBlocked: t.autoBlocked, author: t.author ?? null };
      saveState(state);
      log('skip ' + key + ': autoBlocked (' + t.autoBlocked + ', author=' + (t.author ?? '?') + ')');
      continue;
    }
    // 再検証課題（AI:impl-done）・PR 課題の自動対応は autoPr がゲート
    // （autoTrigger は新規 issue 課題の自動対応）
    if ((t.verify || t.type === 'pr') && !liveConfig('autoPr', false)) continue;
    if (running.has(key) || state.tasks[key]?.inflight) continue;
    const qi = queue.findIndex((q) => keyOf(q.repo.github, q.type, q.number) === key);
    if (qi >= 0) {
      // キュー滞留中に AI:impl-done の着脱で impl⇔verify が入れ替わった場合は
      // 古いエントリを最新候補へ差し替える。差し替えないと impl 滞留中に
      // impl-done が付いた課題が「未pushゲート＋既存エントリ」の二重ブロックで
      // verify へ進めず永久滞留する
      if (!!queue[qi].verify !== !!t.verify) {
        queue.splice(qi, 1, t);
        state.tasks[key] = { ...(state.tasks[key] ?? {}), ...candMeta(t),
          queued: t.verify ? 'verify' : 'impl' };
        saveState(state);
        log(`requeue ${key}: kind changed -> ${t.verify ? 'verify' : 'impl'}`);
      }
      continue;
    }
    if (t.labels.includes(LABEL.running) && !running.has(key)) continue; // reclaimStale が処理
    queue.push(t);
    // パネルの「待機中」表示・SSE 即時反映用に state へキュー待ちを記録する
    state.tasks[key] = { ...(state.tasks[key] ?? {}), ...candMeta(t),
      queued: t.verify ? 'verify' : 'impl', queuedAt: new Date().toISOString() };
    saveState(state);
    log(`queued ${key} "${t.title}"`);
  }
  drainQueue(state);
}

async function main() {
  log(`dispatcher start (poll ${POLL_MS / 1000}s, maxAssess ${MAX_ASSESS}, maxImpl ${MAX_IMPL}, maxPr ${MAX_PR}, mode=${config.permissionMode ?? 'dangerous'}, autoTrigger=${AUTO_TRIGGER})`);
  if (!existsSync(config.devinExe)) {
    // 既定エンジンが非 devin なら起動は継続（devin 解決の課題のみ起動失敗する）
    if ((normEngine(config.engine) ?? 'devin') === 'devin') {
      log(`FATAL: devin exe not found: ${config.devinExe}`);
      process.exit(1);
    }
    log(`WARN: devin exe not found: ${config.devinExe}（devin 解決の課題は起動失敗します）`);
  }
  const state = loadState();
  // 前回プロセスが残したキュー待ちマーカーを掃除（queued はメモリ内キューと
  // 連動する揮発状態。再起動直後はキューが空なので全て陳腐）
  for (const t of Object.values(state.tasks ?? {})) {
    delete t.queued; delete t.queuedAt; delete t.waitReason;
  }
  state.deployedAt ??= new Date().toISOString();
  saveState(state);
  if (TASK_SPEC) {
    await runSingleTask(TASK_SPEC, state);
    log('dispatcher stop');
    return;
  }
  if (ASSESS_SPEC) {
    await runAssess(ASSESS_SPEC, state);
    log('dispatcher stop');
    return;
  }
  if (!DRY_RUN) {
    for (const r of config.repos) await ensureLabels(r.github);
    await reclaimStale(state);
    await sweepOrphanedRuns(state);
  }
  await cycle(state);
  while (!ONCE) {
    // ポーリング周期は毎回 config.json を読み直す（パネルからの変更を即時反映）
    let poll = POLL_MS;
    try { poll = (JSON.parse(readFileSync(configPath, 'utf8')).pollIntervalSec ?? (POLL_MS / 1000)) * 1000; }
    catch { /* 読み込み失敗時は既定値 */ }
    await sleep(poll);
    try { await cycle(state); }
    catch (e) { log(`cycle error: ${e.message}`); }
  }
  if (ONCE && !DRY_RUN) {
    // --once でも起動したタスクは完了まで待つ。待つのは running のみ:
    // queue に残るのは起動可否ゲートで滞留中のタスクで、実行中タスクの
    // 完了時に drainQueue が起動可否を再判定するため running が空なら
    // 残りは永久滞留（unpushed 等）。once には次ポーリングが無いので
    // queue を待ち続けると終了できず、child が /api/start を塞ぐ
    while (running.size) await sleep(1000);
    if (queue.length) {
      log(`once: ${queue.length} gated task(s) left in queue ` +
        queue.map((t) => keyOf(t.repo.github, t.type, t.number)).join(', '));
    }
  }
  log('dispatcher stop');
}

process.on('SIGINT', () => { log('SIGINT: exiting (running sessions continue in background)'); process.exit(0); });
main().catch((e) => { log(`fatal: ${e.stack}`); process.exit(1); });
