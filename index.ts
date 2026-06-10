import type { Plugin, Hooks } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import os from "os";
import path from "path";
import fs from "fs";

interface AgmsgMessage {
  id: number;
  team: string;
  from_agent: string;
  to_agent: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

const AGMSG_DIR = path.join(os.homedir(), ".agents", "skills", "agmsg");
const DEFAULT_DB_PATH = path.join(AGMSG_DIR, "db", "messages.db");
const TEAMS_DIR = path.join(AGMSG_DIR, "teams");

interface PluginOptions {
  dbPath?: string;
  teamName?: string;
  agentName?: string;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

const MIN_AUTO_INTERVAL_MS = 5_000;
const PROCESSING_TIMEOUT_MS = 30_000;

export function createPlugin(client: {
  session: {
    list: (opts?: any) => Promise<any>;
    promptAsync: (opts: any) => Promise<any>;
  };
}, options: PluginOptions = {}): Hooks {
  const dbPath = options.dbPath ?? process.env.AGMSG_DB_PATH ?? DEFAULT_DB_PATH;
  const teamName = options.teamName ?? process.env.AGMSG_TEAM ?? "default_team";
  const agentName = options.agentName ?? process.env.AGMSG_AGENT ?? "opencode";
  const pollIntervalMs = options.pollIntervalMs ?? parseInt(process.env.AGMSG_WATCH_INTERVAL || "30000", 10);
  const log = options.log ?? (() => {});

  if (!fs.existsSync(dbPath)) {
    log(`[agmsg] DB not found at ${dbPath}. Plugin is no-op.`);
    return {};
  }

  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");

  const hasUnreadStmt = db.query(`
    SELECT COUNT(*) as count FROM messages
    WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL
  `);

  const consumeStmt = db.query(`
    UPDATE messages SET read_at = datetime('now')
    WHERE id = (
      SELECT id FROM messages
      WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL
      ORDER BY created_at ASC LIMIT 1
    )
    RETURNING id, team, from_agent, to_agent, body, created_at, read_at
  `);

  const sendStmt = db.query(`
    INSERT INTO messages (team, from_agent, to_agent, body, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const inboxStmt = db.query(`
    SELECT id, team, from_agent, to_agent, body, created_at, read_at
    FROM messages
    WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL
    ORDER BY created_at ASC
  `);

  const historyStmt = db.query(`
    SELECT id, team, from_agent, to_agent, body, created_at, read_at
    FROM messages
    WHERE team = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);

  let sessionID: string | undefined;
  let isIdle = true;
  let isProcessing = false;
  let lastAutoTriggerTime = 0;
  let processingTimer: ReturnType<typeof setTimeout> | undefined;

  const pendingMessages: AgmsgMessage[] = [];

  function formatMessage(msg: AgmsgMessage): string {
    return `[agmsg] Message from "${msg.from_agent}":\n---\n${msg.body}\n---\nReply using the send_agmsg tool if appropriate.`;
  }

  function consumeNext(): AgmsgMessage | undefined {
    try {
      return consumeStmt.get(teamName, agentName) as AgmsgMessage | undefined;
    } catch (e) {
      log(`[agmsg] consume error: ${e}`);
      return undefined;
    }
  }

  function clearProcessingTimer(): void {
    if (processingTimer !== undefined) {
      clearTimeout(processingTimer);
      processingTimer = undefined;
    }
  }

  async function autoProcess(msg: AgmsgMessage): Promise<void> {
    if (!sessionID) {
      pendingMessages.push(msg);
      return;
    }
    isProcessing = true;
    lastAutoTriggerTime = Date.now();
    log(`[agmsg] Auto-trigger from ${msg.from_agent}: "${msg.body.slice(0, 50)}..."`);

    processingTimer = setTimeout(() => {
      if (isProcessing) {
        isProcessing = false;
        log(`[agmsg] Processing timeout (${PROCESSING_TIMEOUT_MS}ms) — reset`);
      }
    }, PROCESSING_TIMEOUT_MS);

    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          parts: [{ type: "text", text: formatMessage(msg) }],
        },
      });
      log(`[agmsg] promptAsync sent for #${msg.id}`);
    } catch (e) {
      log(`[agmsg] promptAsync failed: ${e}`);
      clearProcessingTimer();
      isProcessing = false;
    }
  }

  function onNewMessage(): void {
    while (true) {
      const msg = consumeNext();
      if (!msg) break;

      if (isIdle && !isProcessing && sessionID && (Date.now() - lastAutoTriggerTime > MIN_AUTO_INTERVAL_MS)) {
        autoProcess(msg);
      } else {
        pendingMessages.push(msg);
        log(`[agmsg] Queued #${msg.id} from ${msg.from_agent}`);
      }
    }
  }

  function flushQueue(): void {
    while (pendingMessages.length > 0 && !isProcessing) {
      const msg = pendingMessages.shift()!;
      autoProcess(msg);
    }
  }

  try {
    client.session.list().then((result: any) => {
      const sessions = result?.data ?? result ?? [];
      if (Array.isArray(sessions) && sessions.length > 0) {
        sessionID = sessions[0].id;
        log(`[agmsg] Session: ${sessionID}`);
      }
    }).catch(() => {});
  } catch (e) {
    log(`[agmsg] Session init skipped: ${e}`);
  }

  const pollTimer = setInterval(() => {
    try {
      const result = hasUnreadStmt.get(teamName, agentName) as { count: number };
      if (result.count > 0) {
        console.log(`    📩 [agmsg] ${result.count}件の新着メッセージ`);
        onNewMessage();
      }
    } catch (e) {
      log(`[agmsg] Poll error: ${e}`);
    }
  }, pollIntervalMs);

  if (typeof pollTimer === "object" && "unref" in pollTimer) {
    (pollTimer as any).unref();
  }

  return {
    dispose: async () => {
      clearInterval(pollTimer);
      clearProcessingTimer();
      db.close();
    },

    event: async ({ event }) => {
      const e = event as any;
      if (e.type === "session.idle") {
        sessionID = e.properties.sessionID;
        isIdle = true;
        isProcessing = false;
        clearProcessingTimer();
        flushQueue();
      } else if (e.type.startsWith("session.next.")) {
        isIdle = false;
      } else if (e.type === "session.created") {
        sessionID = e.properties.sessionID;
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const batch = pendingMessages.splice(0);
      while (true) {
        const msg = consumeNext();
        if (!msg) break;
        batch.push(msg);
        log(`[agmsg] Transform-caught #${msg.id} from ${msg.from_agent}`);
      }
      if (batch.length === 0) return;
      for (const msg of batch) {
        (output.messages as any[]).push({
          info: { role: "user" },
          parts: [{ type: "text", text: formatMessage(msg) }],
        });
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (input.sessionID) sessionID = input.sessionID;
      output.system.push(
        "You are connected to agmsg — agent-to-agent messaging over a shared SQLite database. " +
        "Incoming messages from other agents appear as [agmsg] user messages. " +
        "Use `send_agmsg` to send, `agmsg_inbox` to check unread, `agmsg_team` to list members, and `agmsg_history` to view past messages."
      );
    },

    tool: {
      send_agmsg: tool({
        description: "Send a message to another agent on the same agmsg team.",
        args: {
          to_agent: tool.schema.string().describe("Target agent name (e.g. 'agent-b', 'gemini-cli')"),
          body: tool.schema.string().describe("Message content (markdown supported)"),
        },
        execute: async (args) => {
          sendStmt.run(teamName, agentName, args.to_agent, args.body);
          log(`[agmsg] Sent → ${args.to_agent}`);
          return { output: `Message sent to ${args.to_agent}` };
        },
      }),

      agmsg_inbox: tool({
        description: "List unread messages addressed to you. Returns messages from other agents that haven't been read yet. Messages are automatically marked as read after being injected into conversation, so use this to proactively check for new messages.",
        args: {},
        execute: async () => {
          const rows = inboxStmt.all(teamName, agentName) as AgmsgMessage[];
          if (rows.length === 0) return { output: "No unread messages." };
          const lines = rows.map((m: AgmsgMessage) =>
            `[#${m.id}] ${m.created_at} from ${m.from_agent}: ${m.body}`
          );
          return { output: lines.join("\n") };
        },
      }),

      agmsg_team: tool({
        description: "List all agents in the current agmsg team.",
        args: {},
        execute: async () => {
          const configPath = path.join(TEAMS_DIR, teamName, "config.json");
          if (!fs.existsSync(configPath)) {
            return { output: `Team config not found at ${configPath}` };
          }
          const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          const agents = Object.keys(config.agents || {});
          if (agents.length === 0) return { output: "No agents in team." };
          return { output: `Team: ${teamName}\nAgents: ${agents.join(", ")}` };
        },
      }),

      agmsg_history: tool({
        description: "Show recent message history for the current team.",
        args: {
          limit: tool.schema.number().optional().default(20).describe("Number of recent messages to show (default 20)"),
          agent: tool.schema.string().optional().describe("Filter by agent name (from or to)"),
        },
        execute: async (args) => {
          const limit = typeof args.limit === "number" ? args.limit : 20;
          const rows = historyStmt.all(teamName, limit) as AgmsgMessage[];
          if (rows.length === 0) return { output: "No messages found." };
          let filtered = rows;
          if (args.agent) {
            filtered = filtered.filter(
              (m: AgmsgMessage) => m.from_agent === args.agent || m.to_agent === args.agent
            );
          }
          const lines = filtered.map((m: AgmsgMessage) => {
            const read = m.read_at ? "read" : "unread";
            return `[#${m.id}] ${m.created_at} ${m.from_agent} → ${m.to_agent} (${read}): ${m.body}`;
          });
          return { output: lines.join("\n") };
        },
      }),
    },
  };
}

export const OpenCodeAgmsgPlugin: Plugin = async (input) => {
  return createPlugin(input.client);
};

export default OpenCodeAgmsgPlugin;
