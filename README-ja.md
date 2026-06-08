# opencode-agmsg

[README in English](README.md)

`[fujibee/agmsg](https://github.com/fujibee/agmsg)` の SQLite アーキテクチャを利用し、OpenCode AI エージェントへ非同期に他のエージェントからのコンテキストを自動注入するネイティブプラグインです。

外部シェルスクリプトのラッパーとは異なり、OpenCode の Bun ランタイム内部からローカルの SQLite データベースに直接アクセスします。`UPDATE ... RETURNING` によるアトミックなメッセージ取得と WAL（Write-Ahead Logging）モードにより、安全かつ効率的なマルチエージェント連携を実現します。

## 主な特徴

* **チャット履歴を汚さない注入**: `experimental.chat.system.transform` フックを利用し、AI のシステムプロンプトに透過的にコンテキストを追加します。
* **ネイティブ実行**: プロセス起動オーバーヘッドが一切なく、`bun:sqlite` による同期的な SQLite 操作でミリ秒単位で完了。
* **アトミックなメッセージ消費**: `UPDATE ... RETURNING` で 1 クエリに SELECT と UPDATE を統合し、競合状態を完全に排除。
* **アイドル検知**: バックグラウンドタイマーが設定間隔で DB を監視。会話の合間に届いたメッセージは次回ターンでクールダウン待ちなしに即時注入されます。
* **クールダウン制御**: アクティブな会話中の過剰な DB アクセスを防ぎます。

## 前提条件

* OpenCode v1.16.2+
* `agmsg` の SQLite データベース（デフォルトパス、または `AGMSG_DB_PATH` で指定）

## インストール手順

### 1. OpenCode ワークスペースへの配置

```bash
mkdir -p /your/workspace/.opencode/plugins/opencode-agmsg
# index.ts を上記ディレクトリに配置
```

### 2. 設定ファイルへの登録

`opencode.json` にプラグインを追加:

```json
{
  "plugin": [
    "./.opencode/plugins/opencode-agmsg/index.ts"
  ]
}
```

**`npm install` は不要です。** 本プラグインは `bun:sqlite`（Bun 組み込み）を使用するため、追加の依存パッケージはありません。

## 動作の流れ

```
① プロンプト入力待ち（アイドル状態）
② agmsg で他エージェントがメッセージ送信
③ バックグラウンドポーリングが検知、キューに保持（プロンプトは空のまま）
④ ユーザーがプロンプトを入力して Enter
⑤ experimental.chat.system.transform フックが発火
⑥ キューされたメッセージをシステムプロンプト先頭に注入
⑦ 拡張されたプロンプトで AI が応答を生成
```

**アイドル検知タイマー**（デフォルト30秒）がバックグラウンドで DB をポーリングし、新着メッセージがあれば `hasPendingMessages` フラグを立てます。次のプロンプトサイクル（ユーザーの送信）でフラグを検知し、クールダウンをスキップして即座に注入します。アクティブ会話中はクールダウン制御により過剰な DB アクセスを防ぎます。

## 環境変数

| 変数 | デフォルト値 | 説明 |
|------|-------------|------|
| `AGMSG_TEAM` | `default_team` | メッセージルーティング対象のチーム |
| `AGMSG_AGENT` | `opencode` | エージェント名（agmsg の `to_agent` と一致させる） |
| `AGMSG_DB_PATH` | `~/.agents/skills/agmsg/db/messages.db` | agmsg SQLite データベースのパス |
| `AGMSG_COOLDOWN_MS` | `60000` | プロンプトサイクル毎の最小ポーリング間隔（ミリ秒） |
| `AGMSG_WATCH_INTERVAL` | `30` | アイドル検知のポーリング間隔（秒） |

例:

```bash
export AGMSG_TEAM="frontend-refactor-crew"
export AGMSG_COOLDOWN_MS=30000
export AGMSG_WATCH_INTERVAL=10
```

## 謝辞

このプラグインは agmsg なしにはなかったです。(そりゃそうだ)
@fujibee さんに感謝します。

## ライセンス

MIT です。

## Contribute

絶賛大募集です。作り始めて5時間、Dog foodingも足りないので協力お願いしたいです。


