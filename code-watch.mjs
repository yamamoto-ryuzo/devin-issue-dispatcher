// 実行中プロセスのコード乖離検知（issue #95）。
// node は import 済みコードをメモリに保持するため、起動後にディスク上の
// ソースが更新されても再起動まで反映されない。起動時に監視対象の
// mtime+size をスナップショットし、fs.watch（イベント駆動・ポーリングなし）
// で変化を検出した時点を「乖離あり」として codeDrift() で報告する。
// 監視対象: リポジトリ直下の *.mjs（import 済みモジュール群）と panel.html。
import { watch, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const isTarget = (f) => typeof f === 'string' &&
  (f.endsWith('.mjs') || f === 'panel.html');

let snapshot = null;   // Map<file, "mtimeMs:size">（起動時のコード状態）
let drift = null;      // { files: [..], since: ISO } 乖離検知後は非 null
let watcher = null, timer = null, onDrift = null;

const sig = (f) => {
  try { const s = statSync(join(ROOT, f)); return `${s.mtimeMs}:${s.size}`; }
  catch { return null; }
};

function rescan() {
  const cur = new Map();
  try {
    for (const f of readdirSync(ROOT)) if (isTarget(f)) cur.set(f, sig(f));
  } catch { return; }
  const changed = [];
  for (const [f, s] of cur) if (snapshot.get(f) !== s) changed.push(f);
  for (const f of snapshot.keys()) if (!cur.has(f)) changed.push(f);
  if (!changed.length) return;
  drift = { files: changed.sort(), since: drift?.since ?? new Date().toISOString() };
  if (onDrift) { try { onDrift(drift); } catch { /* noop */ } }
}

// 起動時コードの状態を記録し、以後の乖離を監視する。onDrift は乖離を
// 検出するたびに { files, since } で呼ばれる（初回・追加分どちらも）
export function initCodeWatch(opts = {}) {
  if (!snapshot) {
    snapshot = new Map();
    try {
      for (const f of readdirSync(ROOT)) if (isTarget(f)) snapshot.set(f, sig(f));
    } catch { /* noop */ }
  }
  onDrift = opts.onDrift ?? onDrift;
  if (watcher) return;
  try {
    watcher = watch(ROOT, { persistent: false }, (_ev, filename) => {
      if (!isTarget(filename)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; rescan(); }, 400);
    });
    watcher.on('error', () => { watcher = null; });
  } catch { /* 監視不可環境では乖離検知なし（機能低下のみ） */ }
}

export function codeDrift() { return drift; }
