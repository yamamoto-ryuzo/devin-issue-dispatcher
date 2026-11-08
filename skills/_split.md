# 切り分けスキル（split）

このセッションでは課題の実装状況を切り分けます。**コード変更は行わない**。

## やること

1. **実装状況を調査** — `git log`、コードの現状、関連 PR の履歴から、issue で要求されている部分がどこまで実装済みかを確認する

2. **判定 — すべて実装済みなら完了クローズ**
   - 要求が**すべて実装済み**の場合:
     - `gh issue edit <N> -R <owner/repo> --add-label devin:done`
     - 「実装済みを確認したため完了とします」という内容のコメントを投稿（実装済み部分の根拠も簡潔に記す）
     - `gh issue close <N> -R <owner/repo>` で**クローズ**
     - 新 issue は作成せず、手順4へ
   - **一部のみ実装済み**の場合は手順3へ

3. **残作業を新規 issue に切り分け**
   - `gh issue edit <N> -R <owner/repo> --add-label devin:done`
   - 「実装済み部分は完了として切り分け。残りは新規 issue #M に移行」のコメントを投稿
   - `gh issue create -R <owner/repo>` で `[残課題]` タイトルの新規 issue を作成
     （本文に元 issue 参照 `元: #<N>` と残作業の箇条書き）

4. **最後に出力ブロック**

```
<!--split
{"newKey":"<owner/repo> issue#<新issue番号>"}
split-->
```
（全実装済みでクローズした場合は `"newKey": null`）

## 注意

- 完了扱いは「ラベル＋コメント＋クローズ」の3操作で行う
- 新 issue が作成できなかった場合は `newKey` を `null` にして理由を説明する
