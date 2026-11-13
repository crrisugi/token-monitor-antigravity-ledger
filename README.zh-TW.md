# Antigravity 多帳號用量帳本

在 Token Monitor 中按 Google 帳號與自訂日期區間統計 Antigravity（包含 Gemini 與 Claude/GPT 全模型）的 Token 消耗與美元折算費用，並自動完成多帳號歸屬。

## 相容性與安裝

需要 Token Monitor **0.81.0 或更高版本**。Token Monitor 0.80.0 不包含外掛執行階段，會拒絕安裝外掛。0.81.0 及以上版本可直接從內建的 **Token Monitor Community** 目錄安裝，也可透過 **設定 → 外掛 → 從檔案安裝** 匯入完整外掛資料夾或 `.tmplugin` 安裝包，核對後啟用即可。

平台測試：已在 Windows + Token Monitor 0.81.0 實機驗證；macOS 與 Linux 已通過 Node 契約與單元測試校驗，桌面 GUI 待實機驗證。

## 核心功能

- **多帳號自動歸因**：自動辨識本機 Antigravity 目前登入的 Google 帳號，結合活躍帳號心跳時間線、本機配額重置週期與 CLI/工具日誌錨點自動歸因用量；無法符合的歷史記錄單獨歸入「歷史彙總（未歸因）」。
- **全模型覆蓋**：覆蓋 Gemini 系列模型與 Claude Sonnet/Opus、GPT 等非 Gemini 模型，並依 Gemini、Claude/GPT、Gemini 4 Argon 三類配額池區分。
- **自訂日期區間與帳號篩選**：支援按任意 `YYYY-MM-DD ~ YYYY-MM-DD` 日期區間與指定 Google 帳號篩選輸入、輸出、快取讀取、思考 Token 及折算美元費用。
- **獨立的主畫面內嵌視圖**：在模組內部渲染自己的標題列與收起/展開控制，不修改宿主主畫面版面，並支援按需展開各帳號用量佔比對比表。

## 資料與隱私

外掛僅在本機唯讀存取以下資料來源：`~/.gemini/` 下的 Antigravity 工作階段 SQLite 資料庫、Antigravity `state.vscdb`、`~/.antigravity_tools`，以及本機 OAuth 憑證檔案 `jetski-standalone-oauth-token`、`antigravity-oauth-token`、`oauth_creds.json`（憑證檔案僅用於在本機解析提取帳號電子郵件）。所有資料均在本機讀取與持久化，絕不向任何外部網路傳輸憑證、Token 或用量記錄。

## 授權

[MIT](LICENSE) · [更新日誌](CHANGELOG.zh-TW.md) · [全部外掛](../../README.zh-TW.md)
