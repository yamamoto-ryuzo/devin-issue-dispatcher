- 【重要】リリース = main push → Vercel 自動デプロイ。**ローカルで npm run build / tsc
  の成果物を作成・コミットすることは禁止**（ビルドは Vercel 任せ）
- Re:Earth plugin API + TypeScript。plugin/reearth.yml と package.json がバージョン正本
- 3拡張（layers-and-tiles-list / navigation-toolbar / basemap-widget）構成を壊さない
- 運用は他リポジトリと同じ MAIN 運用（実装=ローカルコミットまで、リモートへの push は再検証が行う）。
  push＝即デプロイのため、再検証はデプロイされる内容であることを意識して特に慎重に行う
