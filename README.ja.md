# Antigravity Account Ledger

Token MonitorでAntigravity（GeminiおよびClaude/GPTモデル）のトークン使用量とUSDコスト内訳をGoogleアカウント・カスタム日付範囲ごとに追跡し、複数アカウントへの自動帰属を行います。

## 互換性とインストール

Token Monitor **0.81.0以降**が必要です。Token Monitor 0.80.0にはプラグインランタイムが含まれず、プラグインのインストールは拒否されます。0.81.0以降では、内蔵の **Token Monitor Community** ディレクトリから直接インストールするか、**設定 → プラグイン → ファイルからインストール** でプラグインフォルダまたは`.tmplugin`パッケージを読み込んで有効化してください。

プラットフォームテスト：Windows + Token Monitor 0.81.0 で実機検証済みです。macOS と Linux は Node 契約とユニットテストで検証済みで、デスクトップ GUI は実機検証が未実施です。

## 機能

- **複数アカウントの自動帰属**：ローカルのAntigravity状態から現在のGoogleアカウントを検出し、アクティブアカウントのハートビートタイムライン、ローカルクォータのリセット期間、CLI/ツールログのアンカーを使って使用量を帰属します。一致しない履歴は未帰属として別に集計されます。
- **全モデル対応**：Geminiモデルに加え、Claude Sonnet/OpusやGPTなどの非Geminiモデルを追跡し、Gemini、Claude/GPT、Gemini 4 Argonのクォータプールを区別します。
- **カスタム日付範囲とアカウントフィルター**：任意の`YYYY-MM-DD ~ YYYY-MM-DD`期間と個別のGoogleアカウントで、入力・出力・キャッシュ読み取り・推論トークンおよび推定USDコストを確認できます。
- **独立したホーム埋め込みビュー**：ホストのホームレイアウトを変更せず、モジュール内に独自のヘッダーと折りたたみコントロールを描画します。アカウント別使用量の比較表も必要に応じて展開できます。

## データとプライバシー

プラグインは次のローカルソースのみを読み取り専用で参照します：`~/.gemini/` 配下のAntigravity会話SQLiteデータベース、Antigravity `state.vscdb`、`~/.antigravity_tools`、およびローカルOAuth認証情報ファイル `jetski-standalone-oauth-token`、`antigravity-oauth-token`、`oauth_creds.json`（認証情報ファイルはアカウントのメールアドレスをローカルで解析するためだけに使用します）。すべてのデータはローカルで読み取り・保存され、認証情報、トークン、使用量記録が外部ネットワークへ送信されることはありません。

## ライセンス

[MIT](LICENSE) · [変更履歴](CHANGELOG.ja.md) · [すべてのプラグイン](../../README.ja.md)
