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

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".agents", "skills", "agmsg", "db", "messages.db",
);

interface PluginOptions {
  dbPath?: string;
  teamName?: string;
  agentName?: string;
  cooldownMs?: number;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

export function createPlugin(options: PluginOptions = {}): Hooks {
  const dbPath = options.dbPath ?? process.env.AGMSG_DB_PATH ?? DEFAULT_DB_PATH;
  const teamName = options.teamName ?? process.env.AGMSG_TEAM ?? "default_team";
  const agentName = options.agentName ?? process.env.AGMSG_AGENT ?? "opencode";
  const cooldownMs = options.cooldownMs ?? parseInt(process.env.AGMSG_COOLDOWN_MS || "60000", 10);
  const pollIntervalMs = options.pollIntervalMs ?? parseInt(process.env.AGMSG_WATCH_INTERVAL || "30000", 10);
  const log = options.log ?? (() => {});

  if (!fs.existsSync(dbPath)) {
    log(`[agmsg-opencode-plugin] Database not found at ${dbPath}. Plugin is a no-op.`);
    return {};
  }

  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");

  const peekStmt = db.query(`
    SELECT 1 FROM messages
    WHERE team = ?
      AND (to_agent = ? OR to_agent = 'ALL')
      AND read_at IS NULL
    LIMIT 1
  `);

  // Returns the newest unread message ID and from_agent (for idle notification dedup)
  const peekNewestStmt = db.query(`
    SELECT id, from_agent FROM messages
    WHERE team = ?
      AND (to_agent = ? OR to_agent = 'ALL')
      AND read_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  `);

  const consumeStmt = db.query(`
    UPDATE messages
    SET read_at = datetime('now')
    WHERE id = (
      SELECT id
      FROM messages
      WHERE team = ?
        AND (to_agent = ? OR to_agent = 'ALL')
        AND read_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1
    )
    RETURNING id, team, from_agent, to_agent, body, created_at, read_at
  `);

  const sendStmt = db.query(`
    INSERT INTO messages (team, from_agent, to_agent, body, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  let hasPendingMessages = false;
  let lastCheckTime = 0;
  let lastNotifiedId = 0;

  const pollTimer = setInterval(() => {
    try {
      const row = peekNewestStmt.get(teamName, agentName) as { id: number; from_agent: string } | undefined;
      if (row && row.id > lastNotifiedId) {
        hasPendingMessages = true;
        lastNotifiedId = row.id;
        console.log(`    📩 [agmsg] ${row.from_agent} からメッセージが届きました`);
      }
    } catch (error) {
      log(`[agmsg-opencode-plugin] Poll error: ${error}`);
    }
  }, pollIntervalMs);

  if (typeof pollTimer === "object" && "unref" in pollTimer) {
    (pollTimer as any).unref();
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        if (hasPendingMessages) {
          hasPendingMessages = false;
          const msg = consumeStmt.get(teamName, agentName) as AgmsgMessage | undefined;
          if (msg?.body) {
            log(`[agmsg-opencode-plugin] Idle-caught message from ${msg.from_agent} (#${msg.id})`);
            output.system.push(formatNotification(msg));
            log(`[agmsg-opencode-plugin] Message #${msg.id} consumed`);
          }
          return;
        }

        const now = Date.now();
        if (now - lastCheckTime < cooldownMs) return;
        lastCheckTime = now;

        const msg = consumeStmt.get(teamName, agentName) as AgmsgMessage | undefined;
        if (msg?.body) {
          log(`[agmsg-opencode-plugin] Message from ${msg.from_agent} (#${msg.id})`);
          output.system.push(formatNotification(msg));
          log(`[agmsg-opencode-plugin] Message #${msg.id} consumed`);
        }
      } catch (error) {
        log(`[agmsg-opencode-plugin] Fatal: ${error}`);
        console.error("[agmsg-opencode-plugin] Fatal:", error);
        throw error;
      }
    },
    tool: {
      send_agmsg: tool({
        description: "Send a message to another agent on the same agmsg team. The AI should use this tool when it needs to communicate with other agents (review requests, status updates, handoffs, etc.).",
        args: {
          to_agent: tool.schema.string().describe("Target agent name (e.g. 'qwen', 'gemini-cli')"),
          body: tool.schema.string().describe("Message content (markdown supported)"),
        },
        execute: async (args) => {
          try {
            sendStmt.run(teamName, agentName, args.to_agent, args.body);
            log(`[agmsg-opencode-plugin] Sent message to ${args.to_agent}`);
            return { output: `✅ Message sent to ${args.to_agent}` };
          } catch (error) {
            log(`[agmsg-opencode-plugin] Send error: ${error}`);
            throw error;
          }
        },
      }),
    },
  };
}

function formatNotification(msg: AgmsgMessage): string {
  return `
[agmsg SYSTEM NOTIFICATION]
An asynchronous background coordination request has arrived from external agent "${msg.from_agent}".
You must blend, synthesize, and prioritize the instructions detailed below seamlessly into your immediate task strategy:
--------------------------------------------------
${msg.body}
--------------------------------------------------
`;
}

export const OpenCodeAgmsgPlugin: Plugin = async () => {
  return createPlugin();
};

export default OpenCodeAgmsgPlugin;
