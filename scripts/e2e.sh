#!/usr/bin/env bash
# e2e.sh -- End-to-end test for agmsg-opencode-plugin plugin
#
# Prerequisites:
#   - `bun build` has been run (produces dist/plugin.js)
#   - opencode CLI available in PATH
#
# 1. Creates a temporary workspace with a test agmsg database
# 2. Seeds an unread message for team=test-team / to_agent=opencode
# 3. Runs `opencode run` with plugin loaded and --print-logs
# 4. Verifies message was consumed (read_at populated) -- PRIMARY
# 5. Verifies config was accepted and plugin loaded -- SECONDARY (supplementary)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v opencode &>/dev/null; then
  echo "[FATAL] opencode CLI not found in PATH"
  echo "Install: curl -fsSL https://opencode.ai/install | sh"
  exit 1
fi

if ! command -v rg &>/dev/null; then
  echo "[FATAL] rg (ripgrep) not found in PATH"
  echo "Install: https://github.com/BurntSushi/ripgrep"
  exit 1
fi

if [ ! -f "$ROOT_DIR/dist/plugin.js" ]; then
  echo "[FATAL] dist/plugin.js not found. Run: bun build index.ts --outfile=dist/plugin.js --target=bun"
  exit 1
fi

E2E_DIR=$(mktemp -d /tmp/agmsg-opencode-plugin-e2e-XXXXX)
PLUGIN_DIR="$E2E_DIR/agmsg-opencode-plugin"
TEAM="test-team"
AGENT="opencode"
PASS=0
FAIL=0

cleanup() { rm -rf "$E2E_DIR"; }
trap cleanup EXIT

echo "=== agmsg-opencode-plugin E2E Test ==="
echo "Temp workspace: $E2E_DIR"

mkdir -p "$PLUGIN_DIR"
cp "$ROOT_DIR/dist/plugin.js" "$PLUGIN_DIR/plugin.js"

cat > "$E2E_DIR/opencode.json" <<JSON
{
  "plugin": ["./agmsg-opencode-plugin/plugin.js"]
}
JSON

# Create test agmsg database (matches default path: <storagePath>/db/messages.db)
mkdir -p "$E2E_DIR/db"
DB_PATH="$E2E_DIR/db/messages.db"
sqlite3 "$DB_PATH" <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  read_at TEXT
);
CREATE INDEX idx_unread ON messages(team, to_agent, read_at) WHERE read_at IS NULL;
SQL

sqlite3 "$DB_PATH" \
  "INSERT INTO messages (team, from_agent, to_agent, body) VALUES ('$TEAM', 'e2e-tester', '$AGENT', 'E2E test message')"

echo "[setup] Unread messages in test DB:"
sqlite3 "$DB_PATH" "SELECT id, team, from_agent, to_agent, body, read_at FROM messages"

echo ""
echo "[exec] opencode run \"hello\" --print-logs"
echo "       AGMSG_TEAM=$TEAM AGMSG_STORAGE_PATH=$E2E_DIR"
echo ""

set +e
STDERR_LOG=$(mktemp)
cd "$E2E_DIR" && \
  AGMSG_TEAM="$TEAM" \
  AGMSG_STORAGE_PATH="$E2E_DIR" \
  AGMSG_WATCH_INTERVAL=999999 \
  opencode run "hello" --print-logs >/dev/null 2>"$STDERR_LOG"
RC=$?
set -e

echo "[output] exit_code=$RC"

# Show key log lines (rg for speed, non-fatal)
rg -i "plugin|error|agmsg|config" "$STDERR_LOG" || true

echo ""
echo "=== Verification ==="

# ---- PRIMARY: DB side-effect (message consumption) ----
READ_AT=$(sqlite3 "$DB_PATH" "SELECT read_at FROM messages WHERE team='$TEAM' AND to_agent='$AGENT'")
if [ -n "$READ_AT" ]; then
  echo "[PASS] Message was marked as read (read_at=$READ_AT) -- plugin hook confirmed"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Message was NOT marked as read -- plugin did not consume the message"
  FAIL=$((FAIL + 1))
fi

# ---- SECONDARY: config accepted (supplementary) ----
if rg -q "ConfigInvalid" "$STDERR_LOG"; then
  echo "[FAIL] ConfigInvalidError in opencode output"
  FAIL=$((FAIL + 1))
else
  echo "[PASS] opencode.json config accepted (no ConfigInvalidError)"
  PASS=$((PASS + 1))
fi

# ---- SECONDARY: plugin loaded (supplementary) ----
if rg -q "loading plugin" "$STDERR_LOG"; then
  echo "[PASS] Plugin was loaded by opencode (v1.16.x log style)"
  PASS=$((PASS + 1))
elif [ -n "$READ_AT" ]; then
  echo "[PASS] Plugin was loaded (inferred from message consumption)"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Plugin was not loaded"
  FAIL=$((FAIL + 1))
fi

rm -f "$STDERR_LOG"
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
