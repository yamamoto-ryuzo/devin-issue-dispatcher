- これは QGIS プラグイン開発ハーネス。プラグイン固有の変更は必ずそのプラグインの
  CHANGELOG.md に記録し、ルート CHANGELOG はハーネス基盤・横断変更のみに使う
- バージョンの正本は qgis-plugin/<id>/metadata.txt。バージョンを上げる場合はそこを変更する
- deploy は junction 配置（dev）と parked 復元（use）。AI/自動経路で python/plugins を
  直接書き換えることは禁止
- i18n は i18n/<lang>.json 方式。ツールバー項目は GeoSuite 共有ツールバーへ集約する
- 配布 ZIP 作成前は bandit/detect-secrets 等のセキュリティスキャン相当を通す方針
- 制御面: 即応答プリミティブはプラグイン内、待機・リトライ等は外側スクリプトに置く方針
