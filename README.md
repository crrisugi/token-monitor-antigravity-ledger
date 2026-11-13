# Antigravity Account Ledger

Per-Google-account token usage, USD cost breakdown, custom date-range filtering, and automatic multi-account attribution for Antigravity (Gemini & Claude/GPT models) in Token Monitor.

## Compatibility and installation

Requires Token Monitor **0.81.0 or later**. Token Monitor 0.80.0 does not include the plugin runtime and refuses to install plugins. On 0.81.0+, install this plugin directly from the built-in **Token Monitor Community** directory, or import the complete plugin folder / `.tmplugin` package through **Settings → Plugins → Install from file**, review it and enable it.

Platform testing: verified on Windows with Token Monitor 0.81.0; macOS and Linux pass the Node contract and unit tests, with the desktop GUI still awaiting real-machine verification.

## Features

- **Automatic multi-account attribution**: Detects the active Google account from local Antigravity state and attributes usage through the active-account heartbeat timeline plus local quota reset windows and CLI/tool log anchors. Records it cannot match stay in a separate unattributed bucket.
- **Full model coverage**: Tracks Gemini models and non-Gemini models such as Claude Sonnet/Opus and GPT, separating Gemini, Claude/GPT, and Gemini 4 Argon quota pools.
- **Custom date range & account filter**: Inspect token usage (Input, Output, Cache Read, Reasoning) and estimated USD cost for any `YYYY-MM-DD ~ YYYY-MM-DD` window and individual Google account.
- **Self-contained Home view**: Renders its own header and collapse control inside the module instead of modifying the host Home layout, and includes an optional toggleable account-share comparison table.

## Data and privacy

The plugin reads the following local sources only: Antigravity conversation SQLite databases under `~/.gemini/`, Antigravity `state.vscdb`, `~/.antigravity_tools`, and the local OAuth credential files `jetski-standalone-oauth-token`, `antigravity-oauth-token`, and `oauth_creds.json` — the credential files are only parsed locally to extract the account email. All data is read and persisted locally on your machine. No account credentials, OAuth tokens, or usage records are transmitted to any external network.

## License

[MIT](LICENSE) · [Changelog](CHANGELOG.md) · [All plugins](../../README.md)
