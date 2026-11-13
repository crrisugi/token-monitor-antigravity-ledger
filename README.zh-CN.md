# Antigravity 多账号用量账本

在 Token Monitor 中按 Google 账号与自定义日期区间统计 Antigravity（包含 Gemini 与 Claude/GPT 全模型）的 Token 消耗与美元折算费用，并自动完成多账号归属。

## 兼容性与安装

需要 Token Monitor **0.81.0 或更高版本**。Token Monitor 0.80.0 不包含插件运行时，会拒绝安装插件。0.81.0 及以上版本可直接从内置的 **Token Monitor Community** 目录安装，也可通过 **设置 → 插件 → 从文件安装** 导入完整插件文件夹或 `.tmplugin` 安装包，核对后启用即可。

平台测试：已在 Windows + Token Monitor 0.81.0 实机验证；macOS 与 Linux 已通过 Node 契约与单元测试校验，桌面 GUI 待实机验证。

## 核心功能

- **多账号自动归属**：自动识别本机 Antigravity 当前登录的 Google 账号，结合活跃账号心跳时间线、本地配额重置周期与 CLI/工具日志锚点自动归属用量；无法匹配的历史记录单独归入「历史汇总（未归属）」。
- **全模型覆盖**：覆盖 Gemini 系列模型与 Claude Sonnet/Opus、GPT 等非 Gemini 模型，并按 Gemini、Claude/GPT、Gemini 4 Argon 三类配额池区分。
- **自定义日期区间与账号筛选**：支持按任意 `YYYY-MM-DD ~ YYYY-MM-DD` 日期区间与指定 Google 账号筛选输入、输出、缓存读取、思考 Token 及折算美元费用。
- **独立的主页内嵌视图**：在模块内部渲染自己的标题栏与收起/展开控制，不修改宿主主页布局，并支持按需展开各账号用量占比对比表。

## 数据与隐私

插件仅在本地只读访问以下数据源：`~/.gemini/` 下的 Antigravity 会话 SQLite 数据库、Antigravity `state.vscdb`、`~/.antigravity_tools`，以及本地 OAuth 凭据文件 `jetski-standalone-oauth-token`、`antigravity-oauth-token`、`oauth_creds.json`（凭据文件仅用于在本地解析提取账号邮箱）。所有数据均在本机读取与持久化，绝不向任何外部网络传输凭据、Token 或用量记录。

## 许可证

[MIT](LICENSE) · [更新日志](CHANGELOG.zh-CN.md) · [全部插件](../../README.zh-CN.md)
