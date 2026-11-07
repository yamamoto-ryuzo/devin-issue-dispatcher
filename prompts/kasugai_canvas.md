- メインエンジンは CesiumJS。複数エンジン（Cesium/MapLibre/OpenLayers/Leaflet 等）があるが、
  実装は原則 Cesium 側（web/cesium/）を主対象とし、他エンジンへの波及は必要最小限にする
- 共通部は web/shared/ に置く。エンジン固有の変更を共通層に混入させない
- 大きな仕様変更は docs/ 側ドキュメントも同時更新する
- ローカル確認はブラウザ完結（静的ホスト）を基本とし、Rust サーバ前提の動作に依存しない
