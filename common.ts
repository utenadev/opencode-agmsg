import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";

/* -- types -- */

/** Minimal client interface consumed by createPlugin.
 *  Uses loose types for SDK-provided methods whose return values we never inspect. */
export interface PluginClient {
  session: {
    list: (opts?: Record<string, unknown>) => Promise<{ data?: { id: string }[] }>;
    promptAsync: (opts: any) => Promise<any>;
  };
}

export interface AgmsgMessage {
  id: number;
  team: string;
  from_agent: string;
  to_agent: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface PluginConfig {
  dbPath: string;
  teamName: string;
  agentName: string;
}

interface SendResult {
  ok: boolean;
  id: number;
  to: string;
  team: string;
}

/* -- db -- */

function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  return db;
}

function listMyUnread(db: Database, cfg: PluginConfig): AgmsgMessage[] {
  return db.query(
    `SELECT id, team, from_agent, to_agent, body, created_at, read_at
     FROM messages
     WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL
     ORDER BY created_at ASC`
  ).all(cfg.teamName, cfg.agentName) as AgmsgMessage[];
}

function countMyUnread(db: Database, cfg: PluginConfig): number {
  const row = db.query(
    `SELECT COUNT(*) as count FROM messages
     WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL`
  ).get(cfg.teamName, cfg.agentName) as { count: number };
  return row.count;
}

function consumeMyNextMessage(db: Database, cfg: PluginConfig): AgmsgMessage | null {
  const msg = db.query(
    `UPDATE messages SET read_at = datetime('now')
     WHERE id = (
       SELECT id FROM messages
       WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL
       ORDER BY created_at ASC LIMIT 1
     )
     RETURNING id, team, from_agent, to_agent, body, created_at, read_at`
  ).get(cfg.teamName, cfg.agentName) as AgmsgMessage | undefined;
  return msg ?? null;
}

function sendMessage(db: Database, cfg: PluginConfig, toAgent: string, body: string): SendResult {
  const result = db.query(
    `INSERT INTO messages (team, from_agent, to_agent, body, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     RETURNING id`
  ).get(cfg.teamName, cfg.agentName, toAgent, body) as { id: number };
  return { ok: true, id: result.id, to: toAgent, team: cfg.teamName };
}

function getHistory(db: Database, cfg: PluginConfig, limit: number = 20): AgmsgMessage[] {
  return db.query(
    `SELECT id, team, from_agent, to_agent, body, created_at, read_at
     FROM messages
     WHERE team = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(cfg.teamName, limit) as AgmsgMessage[];
}

/* -- plugin config (config.yaml)  -- */

export const CONFIG_FILE = "config.yaml";

export interface Settings {
  teamName: string;
  agentName: string;
  watchInterval: number;
}

const DEFAULTS: Settings = {
  teamName: "default_team",
  agentName: "opencode",
  watchInterval: 30_000,
};

function configPath(storagePath: string): string {
  // nosemgrep: path-join-resolve-traversal -- storagePath is env/default, not user input
  return path.resolve(storagePath, CONFIG_FILE);
}

function parseYamlValue(raw: string): string | number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return trimmed.replace(/^["']|["']$/g, "");
}

function loadYaml(text: string): Partial<Settings> {
  const out: Record<string, string | number> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const val = trimmed.slice(colon + 1).trim();
    out[key] = parseYamlValue(val);
  }
  const keyMap: Record<string, keyof Settings> = {
    team_name: "teamName",
    agent_name: "agentName",
    watch_interval: "watchInterval",
  };
  const result: Partial<Settings> = {};
  for (const [yamlKey, prop] of Object.entries(keyMap)) {
    if (out[yamlKey] !== undefined) {
      (result[prop] as any) = out[yamlKey];
    }
  }
  return result;
}

function dumpYaml(settings: Partial<Settings>): string {
  const lines: string[] = [
    "# agmsg-opencode-plugin settings",
    "# Created by first-time onboarding. Environment variables override these values.",
    "",
  ];
  if (settings.teamName) lines.push(`team_name: "${settings.teamName}"`);
  if (settings.agentName) lines.push(`agent_name: "${settings.agentName}"`);
  if (settings.watchInterval) lines.push(`watch_interval: ${settings.watchInterval}`);
  lines.push("");
  return lines.join("\n");
}

function loadSettings(storagePath: string): Partial<Settings> {
  const cp = configPath(storagePath);
  if (!fs.existsSync(cp)) return {};
  try {
    return loadYaml(fs.readFileSync(cp, "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(storagePath: string, settings: Partial<Settings>): void {
  const cp = configPath(storagePath);
  const dir = path.dirname(cp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cp, dumpYaml(settings), "utf-8");
}

/** Resolve effective settings: env > config.yaml > defaults.
 *  Writes config.yaml on first run (onboarding). */
function resolveSettings(storagePath: string): Settings {
  const fileSettings = loadSettings(storagePath);
  const effective: Settings = {
    teamName: process.env.AGMSG_TEAM ?? fileSettings.teamName ?? DEFAULTS.teamName,
    agentName: process.env.AGMSG_AGENT ?? fileSettings.agentName ?? DEFAULTS.agentName,
    watchInterval: parseInt(process.env.AGMSG_WATCH_INTERVAL ?? String(fileSettings.watchInterval ?? DEFAULTS.watchInterval), 10),
  };

  // Onboarding: persist effective settings so user can edit config.yaml
  if (!fs.existsSync(configPath(storagePath))) {
    saveSettings(storagePath, effective);
  }

  return effective;
}

/* -- prompts  -- */

const NOTIFICATION = (fromAgent: string, body: string): string =>
  `[agmsg] Message from "${fromAgent}":\n---\n${body}\n---\nReply using the send tool if appropriate.`;

/* -- exports  -- */

export {
  openDb,
  listMyUnread,
  countMyUnread,
  consumeMyNextMessage,
  sendMessage,
  getHistory,
  NOTIFICATION,
  loadSettings,
  saveSettings,
  resolveSettings,
  configPath,
};
export type { SendResult };
