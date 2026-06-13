# agmsg-opencode-plugin

[README in English](README.md)

[fujibee/agmsg](https://github.com/fujibee/agmsg) の SQLite アーキテクチャを利用し、OpenCode AI エージェントにマルチエージェント間メッセージングを提供するネイティブプラグインです。

OpenCode の Bun ランタイムからローカルの SQLite データベースに直接アクセスし、`UPDATE ... RETURNING` によるアトミックなメッセージ取得と WAL モードにより、安全かつ効率的なマルチエージェント連携を実現します。

**このプロジェクトは実験的です。アイデアがあれば試して、どんどん変わっていきます。**

## 主な特徴

* **アイドル時自律応答**: OpenCode がアイドル状態のときに他エージェントからメッセージが届くと、`session.idle` イベント + `client.session.promptAsync()` により**自動でターンが生成され、AI が自律的に応答**します。
* **メッセージとしての注入**: `experimental.chat.messages.transform` フックにより、他エージェントからのメッセージを `{role:"user"}` として正規の会話メッセージとして注入。システムプロンプト領域を経由しないため、UI の破綻がありません。
* **二段構えの配送保証**: バックグラウンドポーリング（アイドル検知用）+ `messages.transform` 内の DB 直接確認により、取りこぼしなく確実に配送。
* **キューイング機構**: 会話中に届いたメッセージはキューに保持し、次の LLM コールで注入。アイドル時は即時 `promptAsync`。
* **ネイティブ実行**: `bun:sqlite` によるプロセス起動オーバーヘッドゼロ。
* **アトミックなメッセージ消費**: `UPDATE ... RETURNING` で 1 クエリに消費と既読マークを統合、競合状態を排除。
* **安全機構**: 処理タイムアウト（30秒）/ 同一メッセージの二重処理防止 / 過剰な auto-trigger 防止（5秒間隔）/ `dispose` フックによる確実なクリーンアップ。
* **自己完結型**: 依存パッケージ不要。`index.ts` + `common.ts` のみで動作。

## 前提条件

* OpenCode v1.16.2+
* `agmsg` の SQLite データベース（デフォルトパス、または `AGMSG_STORAGE_PATH` で指定）

## インストール手順

### 1. OpenCode ワークスペースへの配置

```bash
mkdir -p /your/workspace/.opencode/plugins/agmsg-opencode-plugin
# index.ts を上記ディレクトリに配置
```

### 2. 設定ファイルへの登録

`opencode.json` にプラグインを追加:

```json
{
  "plugin": [
    "./.opencode/plugins/agmsg-opencode-plugin/index.ts"
  ]
}
```

**`npm install` / `bun install` は不要です。** 本プラグインは `index.ts` + `common.ts` の自己完結型。`bun:sqlite`（Bun 組み込み）のみを使用します。

## 動作の流れ

### アイドル時（ユーザー入力待ち）

```
① アイドル状態（session.idle イベント検知中）
② 他エージェントが agmsg でメッセージを送信
③ ポーリングタイマーが検知
④ client.session.promptAsync() で新規ターンを生成
⑤ AI が自律的にメッセージを処理
⑥ 必要に応じて send_agmsg ツールで応答を返信
```

### 会話中（ユーザーがアクティブに操作中）

```
① ユーザーがプロンプトを入力中、会話進行中
② 他エージェントからメッセージが届く
③ ポーリングタイマーが検知、キューに保持
④ 次の LLM コール時、messages.transform フックが発火
⑤ キューされたメッセージを {role:"user"} としてメッセージリストに注入
⑥ AI が拡張されたコンテキストで応答を生成
```

### ワンショット（opencode run 時）

```
① opencode run "prompt" 実行
② プラグインロード、DB 接続
③ messages.transform フックが発火 → DB を直接確認
④ 未読メッセージがあれば消費し、ユーザーメッセージとして注入
⑤ LLM コール、応答生成
```

## 環境変数

| 変数 | デフォルト値 | 説明 |
|------|-------------|------|
| `AGMSG_TEAM` | `default_team` | メッセージルーティング対象のチーム |
| `AGMSG_AGENT` | `opencode` | エージェント名（agmsg の `to_agent` と一致させる） |
| `AGMSG_STORAGE_PATH` | `~/.agents/skills/agmsg` | agmsg データのベースディレクトリ（内部で `/db/messages.db` が追加される） |
| `AGMSG_WATCH_INTERVAL` | `30000` | アイドル検知のポーリング間隔（ミリ秒） |

例:

```bash
export AGMSG_TEAM="frontend-refactor-crew"
export AGMSG_WATCH_INTERVAL=10
```

## v1 → v2 変更履歴

| 項目 | v1 | v2 |
|------|----|----|
| **注入方式** | `system.transform` にメッセージ本文を直追加 | `messages.transform` で `{role:"user"}` として注入 |
| **自律動作** | ❌ 不可 | ✅ `promptAsync` でアイドル時自動応答 |
| **DB 確認** | ポーリングタイマーのみ（取りこぼしあり） | ポーリング + フック内直接確認（二段構え） |
| **クールダウン** | `AGMSG_COOLDOWN_MS` で制御 | 削除（不要） |
| **クリーンアップ** | なし | `dispose` フックあり |
| **UI 破綻** | あり（Z軸問題） | なし |

## 制約 / 既知の問題

- `promptAsync` は 204 No Content で即時復帰する fire-and-forget 型。OpenCode サーバーが実際に処理したかは保証されない（受け付けたことのみ保証）
- `session.idle` イベントに依存。OpenCode のバージョンや実行モードによっては期待通り動作しない可能性がある
- `send_agmsg` による送信は成功確認をしていない（SQLite の制約エラーのみ検知）
- アイドル検知はデフォルト30秒間隔。即時性が必要な場合は `AGMSG_WATCH_INTERVAL` を短く設定

## 謝辞

このプラグインは agmsg なしにはなかったです。(そりゃそうだ)
@fujibee さんに感謝します。

## ライセンス

MIT です。

## Contribute

絶賛大募集です。このプロジェクトはアイデアがあれば試して変わっていきます。Issue / PR お待ちしています。


