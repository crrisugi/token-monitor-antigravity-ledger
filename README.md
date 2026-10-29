# Antigravity Account Ledger

Per-Google-account token usage, USD cost breakdown, and custom date-range attribution for Antigravity (Gemini & Claude/GPT models) in [Token Monitor](https://github.com/Javis603/token-monitor).

## Compatibility and installation

Requires Token Monitor **0.81.0 or later**. Import this repository folder or `.tmplugin` package through **Settings → Plugins → Install from file**, review it and enable it.

## Features

- **Automatic multi-account attribution**: Detects the active Google account from Antigravity's local `state.vscdb` (`antigravityAuthStatus` / `google.geminicodeassist`) and attributes session deltas to each account timeline automatically.
- **Full model coverage**: Tracks both Gemini models (from local brain session logs) and non-Gemini models such as Claude Sonnet/Opus and GPT (from implicit trajectory protobufs and local quota snapshots).
- **Custom date range & account filter**: Inspect token usage (Input, Output, Cache Read, Reasoning) and estimated USD cost for any `YYYY-MM-DD ~ YYYY-MM-DD` window and individual Google account.
- **Collapsible Home & Page views**: Supports compact header collapse in the Home module header and native `context.headerActions` in the Page view, with an optional toggleable account-share comparison table.

## Data and privacy

All data is read and persisted locally on your machine. No account credentials, OAuth tokens, or usage records are transmitted over the network.

## License

[MIT](LICENSE) · [Changelog](CHANGELOG.md)
