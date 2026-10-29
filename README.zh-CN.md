# Antigravity 多账号用量账本

在 [Token Monitor](https://github.com/Javis603/token-monitor) 中按 Google 账号与自定义日期区间统计 Antigravity（包含 Gemini 与 Claude/GPT 全模型）的 Token 消耗与美元折算费用。

## 兼容性与安装

需要 Token Monitor **0.81.0 或更高版本**。通过 **设置 → 插件 → 从文件安装** 导入本仓库文件夹或 `.tmplugin` 安装包，核对后启用即可。

## 核心功能

- **多账号自动归因**：自动从本机 Antigravity 的 `state.vscdb`（`antigravityAuthStatus` / `google.geminicodeassist`）识别当前登录的 Google 账号，并将增量会话自动归入对应账号时间线。
- **全模型覆盖**：同时覆盖 Gemini 系列模型（解析本地 brain 会话日志）与 Claude Sonnet/Opus、GPT 等非 Gemini 模型（解析轨迹 protobuf 与本地配额快照差值）。
- **自定义日期区间与账号筛选**：支持按任意 `YYYY-MM-DD ~ YYYY-MM-DD` 日期区间与指定 Google 账号筛选输入、输出、缓存读取、思考 Token 及折算美元费用。
- **可折叠主界面与独立页面视图**：在主界面模块标题栏与独立页面原生标题栏提供一键收起/展开控制，并支持按需展开各账号用量占比对比表。

## 数据与隐私

所有数据均在本机读取与持久化，不会上传任何账号凭据、OAuth 令牌或用量记录。

## 许可证

[MIT](LICENSE) · [更新日志](CHANGELOG.zh-CN.md)
