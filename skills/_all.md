# 全体フロー（全モード共通）

課題対応の基本の流れ。各ステップは**それぞれ別セッション**が担当し、モード別の詳細は
`_survey`/`_assess`/`_split`/`_impl`/`_pr`/`_done` を参照。

```mermaid
flowchart TD
    subgraph P0["ステップ0: 課題整理（_survey）"]
        U["ユーザーが目的を入力"] --> EX["AI が既存 Issue/コードを確認し<br/>Issue 候補を提案（重複は除く）"]
        EX --> CR["【課題抽出】<br/>起票された Issue"]
    end

    CR --> DET["open Issue/PR を検出"]
    DET --> GT{"起動可否（全セッション共通）<br/>同時起動数上限・repo直列<br/>未pushゲート"}
    GT -->|"起動"| A
    GT -->|"待機"| WT1["【評価待機中】"]
    WT1 -.-> DET

    subgraph P1["ステップ1: 評価 → 切り分け"]
        A{"【評価中】<br/>category / risk / partial"}
        A -->|"partial=true"| SP["切り分け split（別セッション）<br/>実装済み部分を _done で動作確認"]
        SP -->|"OK"| CL["【実装困難・クローズ】<br/>元 issue をクローズ"]
        SP -->|"NG"| RT["完了扱いにせず課題へ戻す"]
        CL --> NC["[残課題]<br/>新 issue"]
        NC --> DET
        RT --> J
        A -->|"partial=false"| J{"判定 category"}
        J -->|"auto / review"| IM["【評価完了】<br/>ステップ2: 対応 impl"]
        J -->|"human"| HLD["【要人間確認】（open）<br/>ユーザーが判定するまで進めない"]
        HLD -->|"ユーザー判断で close"| HC["【人力・クローズ】<br/>issue close"]
        HLD -->|"ユーザー判断で対応"| IM
        J -->|"reject / risk 超過"| REJ["【対応困難・クローズ】<br/>（devin:rejected + close）"]
    end

    subgraph P2["ステップ2: 対応（既定ブランチ直）"]
        IM --> GT2{"起動可否"}
        GT2 -->|"起動"| W["【実装中】<br/>git pull → 実装 → _done で動作確認<br/>NG なら修正ループ（implLoopMax まで）"]
        GT2 -->|"待機"| WT2["【実装待機中】"]
        WT2 -.-> GT2
        W -->|"OK"| CM["【実装完了・検証前】<br/>ローカルコミットのみ<br/>＋ AI:impl-done 付与"]
        W -->|"上限到達"| DF["【上限到達・クローズ】<br/>git revert で自分のコミット除去＋push<br/>→「対応困難」報告 → close"]
        W -->|"異常終了"| NG2["【異常終了・クローズ】（open）<br/>残存コミットは次回 verify で<br/>revert＋push＋報告＋close"]
    end

    subgraph P3["ステップ3: PR処理＝再検証＋push 一体（_pr）"]
        CM --> GT3{"起動可否"}
        GT3 -->|"起動"| AT{"【検証中】<br/>未 push コミットの帰属 (#N)<br/>git log origin/既定ブランチ..HEAD"}
        GT3 -->|"待機"| WT3["【検証待機中】"]
        WT3 -.-> GT3
        AT -->|"全て open の監視課題<br/>（needs-review/failed 除く）"| VOK["_done を違う視点で再検証<br/>（自課題の変更のみ）"]
        AT -->|"closed / rejected 課題"| RV["【検証不合格】<br/>git revert で除去してから<br/>push → close（closed）"]
        AT -->|"帰属不明・needs-review/failed"| RPT["【帰属不明・クローズ】<br/>git revert で除去 → push → 報告<br/>→ 帰属課題 close<br/>※自課題は impl-done のまま再検証へ"]
        VOK -->|"OK"| PS["【完了・クロース】<br/>git push → devin:done 付与<br/>＋ AI:impl-done 除去 → close"]
        VOK -->|"NG"| BK["【差し戻し】<br/>git revert で自コミット除去＋push<br/>＋ AI:impl-done 除去＋コメント<br/>→ 判定1ランク引上げ → 対応キューへ自動復帰"]
        BK -.-> J
    end
```

## 各ステップの要点

- **ステップ0**: 目的が無い場合もリポジトリの現状から改善・修正候補を抽出して課題化してよい。起票はユーザー操作（AI は候補の提案まで）
- **ステップ1**: 評価は**判定のみ**（issue 操作・コード変更はしない）。`partial=true` は切り分けセッションへ引き渡す。新規 `[残課題]` issue は検出されて同じフローを回る（切り分けの再帰）
- **ステップ2**: ブランチは切らず既定ブランチで直接作業。push・PR・ブランチ作成は禁止
- **ステップ3**: 「PR処理」= リモートへのコミット（push）。GitHub PR は作らない。検証 NG は差し戻しのみ（修正は次の対応セッションが新規コミットで行う）

## 常に守ること

- 「実装済み」「完了」は**動作確認の証拠**がある場合のみ使う（憶測で完了にしない）
- 検証ができない環境制約では、未確認の内容を明記して `needs-review` 扱いにする
- 実装セッションは原則 **push しない**（ローカルコミットまで）。リモートへの push は再検証ステップ専用——ただし「対応困難」で断念する時のみ、自分のコミットを revert 除去した後の `git push` は許可する（除去をリモートへ反映して滞留させないため）
- **起動可否は全セッション（評価・対応・再検証）共通**で dispatcher が判定する——同時起動数上限・リポジトリ単位直列・未 push ゲートで落ちた課題は「評価待機中」として次ポーリングで再判定される
- force push・既存データの削除は明示許可がある場合のみ
