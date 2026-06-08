# opencode-agmsg

[README in Japanese (日本語)](README-ja.md)

A native OpenCode plugin providing clean, zero-overhead asynchronous multi-agent orchestration via the [`fujibee/agmsg`](https://github.com/fujibee/agmsg) SQLite architecture.

Unlike traditional shell-wrapper mechanisms that cause process fork inflation, this plugin connects natively to your local SQLite database file inside OpenCode's Bun runtime. It atomically reads and acknowledges incoming coordination messages using `UPDATE ... RETURNING` with Write-Ahead Logging (WAL) concurrency.

## Architectural Advantages

* **Hidden Context Injection**: Hooks into OpenCode's `experimental.chat.system.transform` lifecycle to append coordination context without polluting the visible UI chat transcript.
* **Native Execution Model**: Zero external process overhead — all SQLite operations run synchronously in-process via `bun:sqlite`.
* **Atomic Message Consumption**: Uses `UPDATE ... RETURNING` to claim and read a message in a single query, eliminating race conditions in multi-agent environments.
* **Idle Detection**: Background timer polls the database at a configurable interval. When a new message arrives between prompt cycles, it is queued and injected on the next turn without waiting for the cooldown gate.
* **Cooldown Gating**: Configurable cooldown prevents repeated DB queries on every prompt cycle during active conversation.

## Prerequisites

* OpenCode v1.16.2+
* `agmsg` with a SQLite database at the default path (or custom via `AGMSG_DB_PATH`)

## Installation

### 1. Place in Your OpenCode Workspace

```bash
mkdir -p /your/workspace/.opencode/plugins/opencode-agmsg
# Copy index.ts into the directory above
```

### 2. Register the Plugin

Add to your `opencode.json`:

```json
{
  "plugin": [
    "./.opencode/plugins/opencode-agmsg/index.ts"
  ]
}
```

**No `npm install` required.** The plugin uses `bun:sqlite`, which is built into OpenCode's Bun runtime.

## Injection Flow

```
① Idle — waiting for user input
② Another agent sends a message via agmsg
③ Background polling timer detects the message, sets pending flag (prompt stays empty)
④ User types a prompt and presses Enter
⑤ experimental.chat.system.transform hook fires
⑥ Queued message is injected at the top of the system prompt
⑦ AI generates a response with the augmented context
```

**Idle detection timer** (default 30s) polls the DB in the background. When a new message arrives, it sets `hasPendingMessages`. On the next prompt cycle (user submission), the fast path skips the cooldown gate and injects immediately. During active conversation, the cooldown gate prevents excessive DB queries.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGMSG_TEAM` | `default_team` | Team namespace for message routing |
| `AGMSG_AGENT` | `opencode` | Agent name (must match the `to_agent` in agmsg messages) |
| `AGMSG_DB_PATH` | `~/.agents/skills/agmsg/db/messages.db` | Path to the agmsg SQLite database |
| `AGMSG_COOLDOWN_MS` | `60000` | Minimum interval (ms) between prompt-cycle DB polls |
| `AGMSG_WATCH_INTERVAL` | `30` | Background poll interval (seconds) for idle detection |

Example:

```bash
export AGMSG_TEAM="frontend-refactor-crew"
export AGMSG_COOLDOWN_MS=30000
export AGMSG_WATCH_INTERVAL=10
```

## Acknowledgments

This plugin would not exist without agmsg. (Well, obviously.)
Thanks to [@fujibee](https://github.com/fujibee) for creating such a useful system.

## License

MIT

## Contribute

We warmly welcome contributors. This project is only 5 hours old and needs more dogfooding — your help is greatly appreciated.
