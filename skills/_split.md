# 切り分けスキル（split）

このセッションでは課題の実装状況を切り分けます。**コード変更は行わない**。

## やること

1. **実装状況を調査** — `git log`、コードの現状、関連 PR の履歴から、issue で要求されている部分がどこまで実装済みかを確認する
2. **元 issue を実装済み扱いにする**
   - `gh issue edit <N> -R <owner/repo> --add-label devin:done`
   - 「実装済み部分は完了として切り分け。残りは新規 issue #M に移行」のコメントを投稿
3. **残作業を新規 issue にする**
   - `gh issue create -R <owner/repo>` で作成
   - タイトル先頭に `[残課題]` を付ける
   - 本文に元 issue への参照（`元: #<N>`）と残作業の箇条書き
4. **最後に出力ブロック**

```
<!--split
{"newKey":"<owner/repo> issue#<新issue番号>"}
split-->
```

## 注意

- 元 issue はクローズしない（ラベル＋コメントで完了扱いにする）
- 新 issue が作成できなかった場合は `newKey` を `null` にして理由を説明する
