# agmsg-opencode-plugin

[README in Japanese (日本語)](README-ja.md)

A native OpenCode plugin providing clean, zero-overhead asynchronous multi-agent orchestration via the [`fujibee/agmsg`](https://github.com/fujibee/agmsg) SQLite architecture.

Unlike traditional shell-wrapper mechanisms that cause process fork inflation, this plugin connects natively to your local SQLite database file inside OpenCode's Bun runtime. It atomically reads and acknowledges incoming coordination messages using `UPDATE ... RETURNING` with Write-Ahead Logging (WAL) concurrency.

## Architectural Advantages

* **Idle Auto-Response**: When OpenCode is idle and a message arrives, `session.idle` event + `client.session.promptAsync()` auto-generates a turn for autonomous AI response.
* **Message-Level Injection**: `experimental.chat.messages.transform` hook injects messages as `{role:"user"}` into the proper message list, avoiding UI corruption from system prompt overload.
* **Guaranteed Delivery**: Dual mechanism -- background polling (idle detection) + DB direct check inside `messages.transform` -- ensures no messages are missed.
* **Queue During Conversation**: Messages arriving mid-conversation are queued and injected on the next LLM call. Idle messages trigger immediate `promptAsync`.
* **Native Execution**: Zero external process overhead -- all SQLite operations run in-process via `bun:sqlite`.
* **Atomic Message Consumption**: Uses `UPDATE ... RETURNING` to claim and read a message in a single query, eliminating race conditions in multi-agent environments.
* **Safety Guards**: Processing timeout (30s), duplicate prevention, excessive auto-trigger prevention (5s interval), `dispose` hook for clean teardown.
* **Self-Contained**: No dependencies. `index.ts` + `common.ts` only. No `npm install` / `bun install` required.

## Prerequisites

* OpenCode v1.16.2+
* `agmsg` with a SQLite database at the default path (or custom via `AGMSG_STORAGE_PATH`)

## Installation

### 1. Place in Your OpenCode Workspace

```bash
mkdir -p /your/workspace/.opencode/plugins/agmsg-opencode-plugin
cp index.ts common.ts /your/workspace/.opencode/plugins/agmsg-opencode-plugin/
```

### 2. Register the Plugin

Add to your `opencode.json`:

```json
{
  "plugin": [
    "./.opencode/plugins/agmsg-opencode-plugin/index.ts"
  ]
}
```

**No `npm install` / `bun install` required.** The plugin is self-contained — `index.ts` + `common.ts` only. Both use `bun:sqlite`, which is built into OpenCode's Bun runtime.

## Message Flow

### Idle (waiting for user input)

```
① Idle detected (session.idle event)
② Another agent sends a message via agmsg
③ Polling timer detects the message
④ client.session.promptAsync() generates a new turn
⑤ AI autonomously processes the message
⑥ Optionally replies using send_agmsg tool
```

### Active Conversation (user is actively prompting)

```
① User is typing, conversation in progress
② Another agent sends a message
③ Polling timer detects, queued in pendingMessages[]
④ Next LLM call triggers messages.transform hook
⑤ Queued messages injected as {role:"user"} into the message list
⑥ AI generates response with augmented context
```

### One-shot (opencode run)

```
① opencode run "prompt" executed
② Plugin loads, connects to DB
③ messages.transform hook fires, checks DB directly
④ Unread messages consumed and injected as user messages
⑤ LLM call, response generation
```

## Configuration

### Priority

Settings resolution order (higher wins):

```
PluginOptions (createPlugin arg) > env vars > config.yaml > defaults
```

### config.yaml

Persistent settings at `AGMSG_STORAGE_PATH/config.yaml`. **Auto-created on first run** (onboarding). Existing files are never overwritten.

See `config.yaml.example`:

```yaml
team_name: "default_team"     # Overridden by AGMSG_TEAM
agent_name: "opencode"        # Overridden by AGMSG_AGENT
watch_interval: 30000         # Overridden by AGMSG_WATCH_INTERVAL (ms)
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGMSG_TEAM` | config.yaml value or `default_team` | Team namespace for message routing |
| `AGMSG_AGENT` | config.yaml value or `opencode` | Agent name (must match `to_agent` in agmsg messages) |
| `AGMSG_STORAGE_PATH` | `~/.agents/skills/agmsg` | Base directory for agmsg data. **Not a file path** — the actual DB path is `{AGMSG_STORAGE_PATH}/db/messages.db` |
| `AGMSG_WATCH_INTERVAL` | config.yaml value or `30000` | Background poll interval (ms) for idle detection |

Example:

```bash
export AGMSG_TEAM="frontend-refactor-crew"
export AGMSG_WATCH_INTERVAL=10000
```

## Acknowledgments

This plugin would not exist without agmsg. (Well, obviously.)
Thanks to [@fujibee](https://github.com/fujibee) for creating such a useful system.

## License

MIT

## Contribute

We warmly welcome contributors.
