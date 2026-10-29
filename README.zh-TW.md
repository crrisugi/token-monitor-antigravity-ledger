# Antigravity 多帳號用量帳本

在 [Token Monitor](https://github.com/Javis603/token-monitor) 中按 Google 帳號與自訂日期區間統計 Antigravity（包含 Gemini 與 Claude/GPT 全模型）的 Token 消耗與美元折算費用。

## 相容性與安裝

需要 Token Monitor **0.81.0 或更高版本**。透過 **設定 → 外掛 → 從檔案安裝** 匯入本倉庫資料夾或 `.tmplugin` 安裝包，核對後啟用即可。

## 核心功能

- **多帳號自動歸因**：自動從本機 Antigravity 的 `state.vscdb`（`antigravityAuthStatus` / `google.geminicodeassist`）識別目前登入的 Google 帳號，並將增量工作階段自動歸入對應帳號時間線。
- **全模型覆蓋**：同時覆蓋 Gemini 系列模型與 Claude Sonnet/Opus、GPT 等非 Gemini 模型。
- **自訂日期區間與帳號篩選**：支援按任意 `YYYY-MM-DD ~ YYYY-MM-DD` 日期區間與指定 Google 帳號篩選輸入、輸出、快取讀取、思考 Token 及折算美元費用。
- **可折疊主畫面內嵌視圖**：作為主畫面資訊流內嵌模組展示，在模組標題列提供一鍵收起/展開控制，並支援按需展開各帳號用量佔比對比表。

## 授權

[MIT](LICENSE) · [更新日誌](CHANGELOG.zh-TW.md)
