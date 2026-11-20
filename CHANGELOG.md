# Changelog

## 0.2.0

Switch to Token Monitor host-first accounting (`data.query` for `tools`, `models`, `history`, and `limits`) with restart-safe daily high-water delta attribution: eliminate plugin-side SQLite/Protobuf scanning, hardcoded model pricing tables, and false single-account quota-anchor guesses; detect live accounts via host RPC probe and Antigravity 2.0 `app_storage.json` using freshness comparison; keep lightweight background sync while hidden with offline gap protection.

## 0.1.0

Initial release: per-Google-account token usage ledger with automatic multi-account attribution (active-account heartbeat timeline plus local quota reset and log anchors), USD cost breakdown across Gemini and Claude/GPT models, custom date-range and account filtering, and a self-contained collapsible Home view.
