# Devin Agent Dispatcher — 開発規約

GitHub Issue/PR を監視し、エージェントが評価・実装・再検証を自動実行する常駐システム。
詳細な構成・API・設定は `README.md` と `docs/index.html` を参照。

## 状態変更は必ず UI へ反映する（リロード強制）

**状態を変えたら、パネル表示へ即時反映させること。** 状態と画面の乖離は障害とみなす。

### 原則

- `state.json` / `candidates.json` / `config.json` などのサーバ側状態を変更する処理を追加・変更した場合、**その状態が表示に使われる全箇所で即時反映されることを確認**する
- パネルは**常時ポーリングしない**。状態変化の即時反映は **SSE（`GET /api/events`）の push** が担う: control.mjs が `state.json`/`candidates.json`/`issues.json`/`desired.json` をディレクトリ `fs.watch` し、変化を 400ms デバウンスで配信 → パネルは `refresh()`（＋candidates/issues 変化時は `loadCandidates(false)`）を呼ぶ。SSE 未接続時のフォールバックとして、アクション（評価/対応/一括実行等）または候補取得でアクティブ課題を検出した時だけ `ensurePolling()` が 3秒周期の `refresh()` を開始し、全て完了したら自動停止する。`refresh()` はタスク状態のシグネチャ変化で `loadCandidates(false)` を呼び即時反映する。**表示用フィールドを追加したら `/api/candidates`（または `/api/status`）の応答にも必ず含めること**（`queued` 等の state.tasks 由来フィールドも同様）
- 「実行中」表示は **全実行経路を統一的に扱う**（dispatcher 直接起動の devin セッション・チャット経路・委譲セッション・手動 dispatch）。`chatBusy`/`chatWaiting` だけを見ると dispatcher 起動分が抜け落ちるため、`phase`/`inflight`/`chatDelegated`/`manualRuns`/`runningLabel` を併用する
- ユーザー操作（dispatch/評価/停止/設定変更等）の後は、**サーバ応答を待たずに即リロード or ポーリングで追従**させる設計とし、「ボタンを押したのに画面が変わらない」状態を作らない
- `panel.html` 編集はブラウザリロードで即反映されるが、`control.mjs`（候補 API・status API）の変更は control 再起動が必要。dispatcher.mjs 変更は dispatcher 再起動が必要

### 確認手順

- `node --check control.mjs && node --check dispatcher.mjs`
- `node --test`
- `node dispatcher.mjs --dry-run`（検出のみ・起動なし）
- 再起動: `/api/stop` → タスク `DevinAgentDispatcher` 再起動 → `/api/start`

## 処理ライフサイクル（verify の混在ルール）

- **再検証（verify）と push は一体の仕事**: push は verify セッションのみが行い、検証を通っていないコミットはリモートへ公開しない
- 未pushコミットは `(#N)` で課題に帰属させる。open の監視対象 issue への帰属は混在とみなさず一括 push 可（ただし `devin:needs-review` / `devin:failed` 付きの open 課題は未検証作業のため `git revert` で除去し `git push` で除去をリモートへ反映してから報告し、その課題を close）
- closed / `devin:rejected` の課題に帰属するコミット = 断念済み作業 → verify が `git revert` で除去してから push
- 課題番号を特定できないコミット = 未管理の変更 → `git revert` で除去し `git push` で除去をリモートへ反映してから報告
- impl が完了せず終了する時（「対応困難」・実現不可能・判断不能・矛盾指示による中断）は、自分課題の `Issue: #N` コミットを `git revert` で除去し `git push` で除去をリモートへ反映してから報告し、課題を close（この push は断念時の除去目的のみ許可。`AI:impl-done` 付与済みなら除去。未コミットの作業ツリー変更は残す・コメントに明記）
- verify NG の差し戻しも、自分課題の `Issue: #N` コミットを `git revert` で除去し `git push` で除去をリモートへ反映してから報告（除去を反映しないと差し戻し後の impl が gated で起動しない。`AI:impl-done` 付与済みなら除去。未コミットの作業ツリー変更は残す・コメントに明記）
- `git reset` は禁止（他課題コミットを破壊する）
