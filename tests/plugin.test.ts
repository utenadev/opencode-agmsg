import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { createPlugin } from "../index.ts";

// Prevent background polling timers from interfering with tests
process.env.AGMSG_WATCH_INTERVAL = "999999";
afterAll(() => { delete process.env.AGMSG_WATCH_INTERVAL; });

type SystemTransformOutput = { system: string[] };

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agmsg-"));
  const dbPath = join(dir, "test.db");
  const db = new Database(dbPath);
  db.exec(`
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
  `);
  db.close();
  return dbPath;
}

function seed(dbPath: string, row: { team: string; from_agent: string; to_agent: string; body?: string; created_at?: string }) {
  const db = new Database(dbPath);
  const cols = "team, from_agent, to_agent, body" + (row.created_at ? ", created_at" : "");
  const placeholders = "?, ?, ?, ?" + (row.created_at ? ", ?" : "");
  const params: unknown[] = [row.team, row.from_agent, row.to_agent, row.body ?? "hello"];
  if (row.created_at) params.push(row.created_at);
  db.run(`INSERT INTO messages (${cols}) VALUES (${placeholders})`, ...params);
  db.close();
}

function countRead(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.query("SELECT COUNT(*) AS cnt FROM messages WHERE read_at IS NOT NULL").get() as { cnt: number };
  db.close();
  return row.cnt;
}

function countUnread(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.query("SELECT COUNT(*) AS cnt FROM messages WHERE read_at IS NULL").get() as { cnt: number };
  db.close();
  return row.cnt;
}

const TEAM = "test-team";
const AGENT = "opencode";

function makeOutput(): SystemTransformOutput {
  return { system: [""] };
}

describe("createPlugin()", () => {
  it("returns empty hooks when database does not exist", () => {
    const hooks = createPlugin({ dbPath: "/nonexistent/missing.db" });
    expect(hooks).toEqual({});
  });

  it("does not inject system prompt when no unread messages exist", () => {
    const dbPath = freshDb();
    const hooks = createPlugin({ dbPath, teamName: TEAM, agentName: AGENT });
    const output = makeOutput();
    hooks["experimental.chat.system.transform"]?.(undefined, output);
    expect(output.system).toEqual([""]);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("injects agmsg notification into system prompt for unread message", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "Test instruction" });
    const hooks = createPlugin({ dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeOutput();
    hooks["experimental.chat.system.transform"]?.(undefined, output);

    expect(output.system.length).toBe(2);
    expect(output.system[1]).toContain("Test instruction");
    expect(output.system[1]).toContain("gemini");
    expect(output.system[1]).toContain("agmsg SYSTEM NOTIFICATION");
    expect(countRead(dbPath)).toBe(1);
    expect(countUnread(dbPath)).toBe(0);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("does not inject for a different team", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "other-team", from_agent: "gemini", to_agent: AGENT, body: "Wrong team" });
    const hooks = createPlugin({ dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeOutput();
    hooks["experimental.chat.system.transform"]?.(undefined, output);
    expect(output.system).toEqual([""]);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("does not inject for a different agent", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: "some-other-agent", body: "Wrong agent" });
    const hooks = createPlugin({ dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeOutput();
    hooks["experimental.chat.system.transform"]?.(undefined, output);
    expect(output.system).toEqual([""]);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("marks message as read after processing (atomic consume)", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "goose", to_agent: AGENT, body: "Atomic test" });
    const hooks = createPlugin({ dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeOutput();
    hooks["experimental.chat.system.transform"]?.(undefined, output);
    expect(countRead(dbPath)).toBe(1);
    expect(countUnread(dbPath)).toBe(0);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("respects cooldown and does not process twice in quick succession", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "goose", to_agent: AGENT, body: "First" });
    seed(dbPath, { team: TEAM, from_agent: "goose", to_agent: AGENT, body: "Second" });

    const hooks = createPlugin({ dbPath, teamName: TEAM, agentName: AGENT });

    const out1 = makeOutput();
    hooks["experimental.chat.system.transform"]?.(undefined, out1);
    expect(out1.system.length).toBe(2);
    expect(out1.system[1]).toContain("First");

    const out2 = makeOutput();
    hooks["experimental.chat.system.transform"]?.(undefined, out2);
    expect(out2.system).toEqual([""]);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("processes ALL-targeted messages", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "coordinator", to_agent: "ALL", body: "Broadcast message" });
    const hooks = createPlugin({ dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeOutput();
    hooks["experimental.chat.system.transform"]?.(undefined, output);
    expect(output.system.length).toBe(2);
    expect(output.system[1]).toContain("Broadcast message");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("processes oldest unread message first (FIFO order)", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "agent-a", to_agent: AGENT, body: "Oldest", created_at: "2024-01-01T00:00:00Z" });
    seed(dbPath, { team: TEAM, from_agent: "agent-b", to_agent: AGENT, body: "Newest" });

    const hooks = createPlugin({ dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeOutput();
    hooks["experimental.chat.system.transform"]?.(undefined, output);
    expect(output.system.length).toBe(2);
    expect(output.system[1]).toContain("agent-a");
    expect(output.system[1]).toContain("Oldest");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("propagates errors and does not mark message as read on failure", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "test" });

    const hooks = createPlugin({ dbPath, teamName: TEAM, agentName: AGENT });

    // Drop the table from another connection to make the prepared statement fail
    const killer = new Database(dbPath);
    killer.exec("DROP TABLE messages");
    killer.close();

    const output = makeOutput();
    expect(() => hooks["experimental.chat.system.transform"]?.(undefined, output)).toThrow();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });
});
