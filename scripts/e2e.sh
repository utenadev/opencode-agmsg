#!/usr/bin/env bash
# e2e.sh — End-to-end test for agmsg-opencode-plugin plugin
#
# 1. Creates a temporary workspace with a test agmsg database
# 2. Seeds an unread message for team=test-team / to_agent=opencode
# 3. Runs `opencode run` with plugin loaded and --print-logs
# 4. Verifies the plugin loaded without config errors
# 5. Verifies the message was consumed (read_at populated)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v opencode &>/dev/null; then
  echo "[FATAL] opencode CLI not found in PATH"
  echo "Install: curl -fsSL https://opencode.ai/install | sh"
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
cp "$ROOT_DIR/index.ts" "$PLUGIN_DIR/index.ts"
# Copy node_modules so runtime imports (e.g. @opencode-ai/plugin tool helper) resolve
if [ -d "$ROOT_DIR/node_modules/@opencode-ai" ]; then
  mkdir -p "$PLUGIN_DIR/node_modules"
  cp -r "$ROOT_DIR/node_modules/@opencode-ai" "$PLUGIN_DIR/node_modules/@opencode-ai"
fi

cat > "$E2E_DIR/opencode.json" <<JSON
{
  "plugin": ["./agmsg-opencode-plugin/index.ts"]
}
JSON

# Create test agmsg database
DB_PATH="$E2E_DIR/agmsg_e2e.db"
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
echo "       AGMSG_TEAM=$TEAM AGMSG_DB_PATH=$DB_PATH"
echo ""

set +e
STDERR_LOG=$(mktemp)
cd "$E2E_DIR" && \
  AGMSG_TEAM="$TEAM" \
  AGMSG_DB_PATH="$DB_PATH" \
  opencode run "hello" --print-logs >/dev/null 2>"$STDERR_LOG"
RC=$?
set -e

echo "[output] exit_code=$RC"

# Show key log lines
grep -E "plugin|error|ConfigInvalid" "$STDERR_LOG" || true

echo ""
echo "=== Verification ==="

# Check that the config was valid (no ConfigInvalidError)
if grep -q "ConfigInvalid" "$STDERR_LOG"; then
  echo "[FAIL] ConfigInvalidError in opencode output"
  FAIL=$((FAIL + 1))
else
  echo "[PASS] opencode.json config accepted"
  PASS=$((PASS + 1))
fi

# Check plugin was loaded
if grep -q "loading plugin" "$STDERR_LOG"; then
  echo "[PASS] Plugin was loaded by opencode"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Plugin was not loaded"
  FAIL=$((FAIL + 1))
fi

# Check the message was consumed (read_at is set)
READ_AT=$(sqlite3 "$DB_PATH" "SELECT read_at FROM messages WHERE team='$TEAM' AND to_agent='$AGENT'")
if [ -n "$READ_AT" ]; then
  echo "[PASS] Message was marked as read (read_at=$READ_AT)"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Message was NOT marked as read"
  FAIL=$((FAIL + 1))
fi

rm -f "$STDERR_LOG"
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
