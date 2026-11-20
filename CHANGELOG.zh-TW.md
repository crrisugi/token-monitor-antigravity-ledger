# 更新日誌

## 0.2.0

重構為宿主優先架構：直接復用 Token Monitor 宿主的 `data.query`（`tools` / `models` / `history` / `limits`）取得用量與折算費用，徹底移除外掛側 SQLite/Protobuf 掃描、硬編碼定價表與易誤歸屬的配額錨點猜測；改用可跨重啟的按日高水位增量即時分帳，結合宿主即時 RPC 探測、Antigravity 2.0 `app_storage.json` 時效擇優以及背景隱藏同步與離線斷檔保護。

## 0.1.0

首次發布：按 Google 帳號統計 Antigravity（含 Gemini 與 Claude/GPT 模型）的 Token 用量與美元折算費用，支援活躍帳號心跳時間線與本機配額/日誌錨點的多帳號自動歸因，並提供自訂日期區間與帳號篩選，以及獨立可折疊的主畫面內嵌視圖。
