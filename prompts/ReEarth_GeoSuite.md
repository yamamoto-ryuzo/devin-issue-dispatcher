- 【重要】リリース = main push → Vercel 自動デプロイ。**ローカルで npm run build / tsc
  の成果物を作成・コミットすることは禁止**（ビルドは Vercel 任せ）
- Re:Earth plugin API + TypeScript。plugin/reearth.yml と package.json がバージョン正本
- 3拡張（layers-and-tiles-list / navigation-toolbar / basemap-widget）構成を壊さない
- main への直接 push は絶対禁止（即デプロイになるため影響が大きい）。必ず PR 経由
