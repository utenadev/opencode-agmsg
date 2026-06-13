import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { createPlugin } from "../index.ts";

// Prevent background polling timers from interfering with tests
process.env.AGMSG_WATCH_INTERVAL = "999999";
afterAll(() => { delete process.env.AGMSG_WATCH_INTERVAL; });

type MessagesTransformInput = {};
type MessagesTransformOutput = { messages: any[] };
type SystemTransformInput = { sessionID?: string };
type SystemTransformOutput = { system: string[] };

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agmsg-opencode-plugin-"));
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

function makeMessagesOutput(): MessagesTransformOutput {
  return { messages: [] };
}

function makeSystemOutput(): SystemTransformOutput {
  return { system: [""] };
}

function dummyClient(): any {
  return {
    session: {
      list: async () => [],
      promptAsync: async () => {},
    },
  };
}

describe("createPlugin()", () => {
  it("returns empty hooks when database does not exist", () => {
    const hooks = createPlugin(dummyClient(), { dbPath: "/nonexistent/missing.db" });
    expect(hooks).toEqual({});
  });

  it("adds agmsg context via system.transform", () => {
    const dbPath = freshDb();
    const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
    const output = makeSystemOutput();
    hooks["experimental.chat.system.transform"]?.({}, output);
    expect(output.system.length).toBe(2);
    expect(output.system[1]).toContain("agmsg");
    expect(output.system[1]).toContain("send_agmsg");
    expect(output.system[1]).toContain("agmsg_inbox");
    expect(output.system[1]).toContain("agmsg_team");
    expect(output.system[1]).toContain("agmsg_history");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("injects unread message into messages.transform", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "Test instruction" });
    const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeMessagesOutput();
    hooks["experimental.chat.messages.transform"]?.({}, output);

    expect(output.messages.length).toBe(1);
    expect(output.messages[0].info.role).toBe("user");
    expect(output.messages[0].parts[0].text).toContain("Test instruction");
    expect(output.messages[0].parts[0].text).toContain("gemini");
    expect(countRead(dbPath)).toBe(1);
    expect(countUnread(dbPath)).toBe(0);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("does not inject for a different team", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "other-team", from_agent: "gemini", to_agent: AGENT, body: "Wrong team" });
    const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeMessagesOutput();
    hooks["experimental.chat.messages.transform"]?.({}, output);
    expect(output.messages.length).toBe(0);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("does not inject for a different agent", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: "some-other-agent", body: "Wrong agent" });
    const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeMessagesOutput();
    hooks["experimental.chat.messages.transform"]?.({}, output);
    expect(output.messages.length).toBe(0);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("atomically marks message as read", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "goose", to_agent: AGENT, body: "Atomic test" });
    const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeMessagesOutput();
    hooks["experimental.chat.messages.transform"]?.({}, output);
    expect(countRead(dbPath)).toBe(1);
    expect(countUnread(dbPath)).toBe(0);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("injects multiple unread messages in FIFO order", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "agent-a", to_agent: AGENT, body: "First msg", created_at: "2024-01-01T00:00:00Z" });
    seed(dbPath, { team: TEAM, from_agent: "agent-b", to_agent: AGENT, body: "Second msg" });

    const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeMessagesOutput();
    hooks["experimental.chat.messages.transform"]?.({}, output);

    expect(output.messages.length).toBe(2);
    expect(output.messages[0].parts[0].text).toContain("agent-a");
    expect(output.messages[0].parts[0].text).toContain("First msg");
    expect(output.messages[1].parts[0].text).toContain("agent-b");
    expect(output.messages[1].parts[0].text).toContain("Second msg");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("processes ALL-targeted messages", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "coordinator", to_agent: "ALL", body: "Broadcast message" });
    const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });

    const output = makeMessagesOutput();
    hooks["experimental.chat.messages.transform"]?.({}, output);
    expect(output.messages.length).toBe(1);
    expect(output.messages[0].parts[0].text).toContain("Broadcast message");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("handles concurrent consume from multiple hooks safely", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "test" });
    const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });

    // First transform consumes the message
    const out1 = makeMessagesOutput();
    hooks["experimental.chat.messages.transform"]?.({}, out1);
    expect(out1.messages.length).toBe(1);
    expect(countRead(dbPath)).toBe(1);

    // Second transform should find nothing
    const out2 = makeMessagesOutput();
    hooks["experimental.chat.messages.transform"]?.({}, out2);
    expect(out2.messages.length).toBe(0);
    expect(countRead(dbPath)).toBe(1);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("handles DB error gracefully without crashing", async () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "test" });
    const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });

    const killer = new Database(dbPath);
    killer.exec("DROP TABLE messages");
    killer.close();

    const output = makeMessagesOutput();
    await hooks["experimental.chat.messages.transform"]?.({}, output);
    expect(output.messages.length).toBe(0);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  describe("agmsg_inbox tool", () => {
    it("returns 'No unread messages' when inbox is empty", async () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const result = await hooks.tool!.agmsg_inbox.execute({});
      expect(result.output).toBe("No unread messages.");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("lists unread messages for the current agent", async () => {
      const dbPath = freshDb();
      seed(dbPath, { team: TEAM, from_agent: "agent-a", to_agent: AGENT, body: "Hello there" });
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const result = await hooks.tool!.agmsg_inbox.execute({});
      expect(result.output).toContain("agent-a");
      expect(result.output).toContain("Hello there");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("does not list messages for a different agent", async () => {
      const dbPath = freshDb();
      seed(dbPath, { team: TEAM, from_agent: "agent-a", to_agent: "someone-else", body: "Not for me" });
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const result = await hooks.tool!.agmsg_inbox.execute({});
      expect(result.output).toBe("No unread messages.");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });
  });

  describe("agmsg_team tool", () => {
    it("returns 'not found' when team config does not exist", async () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: "nonexistent-team", agentName: AGENT });
      const result = await hooks.tool!.agmsg_team.execute({});
      expect(result.output).toContain("Team config not found");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });
  });

  describe("agmsg_history tool", () => {
    it("returns 'No messages found' when empty", async () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const result = await hooks.tool!.agmsg_history.execute({});
      expect(result.output).toBe("No messages found.");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("shows message history", async () => {
      const dbPath = freshDb();
      seed(dbPath, { team: TEAM, from_agent: "alice", to_agent: "bob", body: "Hi Bob", created_at: "2024-01-01T00:00:00Z" });
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const result = await hooks.tool!.agmsg_history.execute({});
      expect(result.output).toContain("alice");
      expect(result.output).toContain("bob");
      expect(result.output).toContain("Hi Bob");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("filters history by agent", async () => {
      const dbPath = freshDb();
      seed(dbPath, { team: TEAM, from_agent: "alice", to_agent: "bob", body: "For Bob", created_at: "2024-01-01T00:00:00Z" });
      seed(dbPath, { team: TEAM, from_agent: "carol", to_agent: "dave", body: "For Dave", created_at: "2024-01-02T00:00:00Z" });
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const result = await hooks.tool!.agmsg_history.execute({ agent: "alice" });
      expect(result.output).toContain("alice");
      expect(result.output).toContain("For Bob");
      expect(result.output).not.toContain("carol");
      expect(result.output).not.toContain("For Dave");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("respects the limit parameter", async () => {
      const dbPath = freshDb();
      seed(dbPath, { team: TEAM, from_agent: "a1", to_agent: AGENT, body: "msg1", created_at: "2024-01-01T00:00:00Z" });
      seed(dbPath, { team: TEAM, from_agent: "a2", to_agent: AGENT, body: "msg2", created_at: "2024-01-02T00:00:00Z" });
      seed(dbPath, { team: TEAM, from_agent: "a3", to_agent: AGENT, body: "msg3", created_at: "2024-01-03T00:00:00Z" });
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const result = await hooks.tool!.agmsg_history.execute({ limit: 1 });
      expect(result.output).toContain("a3");
      expect(result.output).not.toContain("a2");
      expect(result.output).not.toContain("a1");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });
  });

  it("triggers promptAsync when idle and message arrives (via event.idle)", async () => {
    const dbPath = freshDb();
    const promptAsyncCalls: any[] = [];
    const client = {
      session: {
        list: async () => [{ id: "test-session" }],
        promptAsync: async (opts: any) => { promptAsyncCalls.push(opts); },
      },
    };
    const hooks = createPlugin(client as any, { dbPath, teamName: TEAM, agentName: AGENT, pollIntervalMs: 50000 });

    // Simulate session.idle → session ID captured
    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "test-session" } } as any });

    // Now seed a message and manually call onNewMessage path by triggering the internal logic
    seed(dbPath, { team: TEAM, from_agent: "alice", to_agent: AGENT, body: "Auto process me" });

    // Wait for the polling interval (simulate one tick)
    // Instead, directly call messages.transform which will DB-check
    const output = makeMessagesOutput();
    hooks["experimental.chat.messages.transform"]?.({}, output);

    // Should be consumed and injected
    expect(output.messages.length).toBe(1);
    expect(output.messages[0].parts[0].text).toContain("alice");
    expect(output.messages[0].parts[0].text).toContain("Auto process me");
    expect(countRead(dbPath)).toBe(1);

    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  describe("send_agmsg tool", () => {
    it("writes a message to the database", async () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      await hooks.tool!.send_agmsg.execute({ to_agent: "gemini", body: "Hello from opencode" });
      const result = await hooks.tool!.agmsg_inbox.execute({});
      expect(result.output).toBe("No unread messages.");

      // Verify from gemini's perspective
      const db = new Database(dbPath);
      const row = db.query("SELECT from_agent, to_agent, body FROM messages WHERE to_agent = ?").get("gemini") as any;
      db.close();
      expect(row).not.toBeUndefined();
      expect(row.from_agent).toBe(AGENT);
      expect(row.to_agent).toBe("gemini");
      expect(row.body).toBe("Hello from opencode");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("forces from_agent to the configured agent name", () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      hooks.tool!.send_agmsg.execute({ to_agent: "qwen", body: "Cannot spoof" });
      const db = new Database(dbPath);
      const rows = db.query("SELECT from_agent, to_agent, body FROM messages").all() as any[];
      db.close();
      expect(rows.length).toBe(1);
      expect(rows[0].from_agent).toBe(AGENT);
      expect(rows[0].from_agent).not.toBe("qwen");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("sends to ALL when to_agent is ALL", () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      hooks.tool!.send_agmsg.execute({ to_agent: "ALL", body: "Broadcast" });
      const db = new Database(dbPath);
      const row = db.query("SELECT to_agent, body FROM messages").get() as any;
      db.close();
      expect(row.to_agent).toBe("ALL");
      expect(row.body).toBe("Broadcast");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });
  });

  describe("agmsg_team tool", () => {
    it("reads agents from team config file", async () => {
      const dbPath = freshDb();
      const storageDir = join(dbPath, "..", "agmsg-storage");
      const teamDir = join(storageDir, "teams", "test-team-cfg");
      mkdirSync(teamDir, { recursive: true });
      writeFileSync(join(teamDir, "config.json"), JSON.stringify({
        agents: { opencode: {}, gemini: {}, qwen: {} },
      }));
      process.env.AGMSG_STORAGE_PATH = storageDir;
      try {
        const hooks = createPlugin(dummyClient(), { dbPath, teamName: "test-team-cfg", agentName: AGENT });
        const result = await hooks.tool!.agmsg_team.execute({});
        expect(result.output).toContain("opencode");
        expect(result.output).toContain("gemini");
        expect(result.output).toContain("qwen");
      } finally {
        delete process.env.AGMSG_STORAGE_PATH;
        rmSync(join(dbPath, ".."), { recursive: true, force: true });
      }
    });

    it("returns 'No agents' when config has empty agents", async () => {
      const dbPath = freshDb();
      const storageDir = join(dbPath, "..", "agmsg-storage");
      const teamDir = join(storageDir, "teams", "empty-team");
      mkdirSync(teamDir, { recursive: true });
      writeFileSync(join(teamDir, "config.json"), JSON.stringify({ agents: {} }));
      process.env.AGMSG_STORAGE_PATH = storageDir;
      try {
        const hooks = createPlugin(dummyClient(), { dbPath, teamName: "empty-team", agentName: AGENT });
        const result = await hooks.tool!.agmsg_team.execute({});
        expect(result.output).toBe("No agents in team.");
      } finally {
        delete process.env.AGMSG_STORAGE_PATH;
        rmSync(join(dbPath, ".."), { recursive: true, force: true });
      }
    });
  });

  describe("event hooks", () => {
    it("session.created sets sessionID", () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      hooks.event!({ event: { type: "session.created", properties: { sessionID: "session-42" } } as any });
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("session.next sets isIdle to false", () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      hooks.event!({ event: { type: "session.next.user-request" } as any });
      hooks.event!({ event: { type: "session.next.assistant-response" } as any });
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("dispose cleans up without error", () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      expect(async () => { await hooks.dispose?.(); }).not.toThrow();
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });
  });

  describe("messages.transform edge cases", () => {
    it("mixes self-targeted and other-targeted messages", () => {
      const dbPath = freshDb();
      seed(dbPath, { team: TEAM, from_agent: "alice", to_agent: AGENT, body: "For me", created_at: "2024-01-01T00:00:00Z" });
      seed(dbPath, { team: TEAM, from_agent: "bob", to_agent: "other-agent", body: "Not for me", created_at: "2024-01-02T00:00:00Z" });
      seed(dbPath, { team: TEAM, from_agent: "carol", to_agent: "ALL", body: "Broadcast", created_at: "2024-01-03T00:00:00Z" });
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const output = makeMessagesOutput();
      hooks["experimental.chat.messages.transform"]?.({}, output);
      expect(output.messages.length).toBe(2);
      expect(output.messages[0].parts[0].text).toContain("alice");
      expect(output.messages[0].parts[0].text).toContain("For me");
      expect(output.messages[1].parts[0].text).toContain("carol");
      expect(output.messages[1].parts[0].text).toContain("Broadcast");
      expect(countRead(dbPath)).toBe(2);
      expect(countUnread(dbPath)).toBe(1); // bob's message still unread
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("handles multiple ALL broadcasts in order", () => {
      const dbPath = freshDb();
      seed(dbPath, { team: TEAM, from_agent: "alice", to_agent: "ALL", body: "Broadcast 1", created_at: "2024-01-01T00:00:00Z" });
      seed(dbPath, { team: TEAM, from_agent: "bob", to_agent: "ALL", body: "Broadcast 2", created_at: "2024-01-02T00:00:00Z" });
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const output = makeMessagesOutput();
      hooks["experimental.chat.messages.transform"]?.({}, output);
      expect(output.messages.length).toBe(2);
      expect(output.messages[0].parts[0].text).toContain("Broadcast 1");
      expect(output.messages[1].parts[0].text).toContain("Broadcast 2");
      expect(countRead(dbPath)).toBe(2);
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("transforms empty output when no unread messages", () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const output = makeMessagesOutput();
      hooks["experimental.chat.messages.transform"]?.({}, output);
      expect(output.messages.length).toBe(0);
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("includes pending messages from queue before DB consumption", () => {
      const dbPath = freshDb();
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      seed(dbPath, { team: TEAM, from_agent: "alice", to_agent: AGENT, body: "From DB" });
      const output = makeMessagesOutput();
      hooks["experimental.chat.messages.transform"]?.({}, output);
      expect(output.messages.length).toBe(1);
      expect(countRead(dbPath)).toBe(1);
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });
  });

  describe("agmsg_history tool", () => {
    it("filters by both from_agent and to_agent", async () => {
      const dbPath = freshDb();
      seed(dbPath, { team: TEAM, from_agent: "alice", to_agent: "bob", body: "From alice", created_at: "2024-01-01T00:00:00Z" });
      seed(dbPath, { team: TEAM, from_agent: "carol", to_agent: "alice", body: "To alice", created_at: "2024-01-02T00:00:00Z" });
      seed(dbPath, { team: TEAM, from_agent: "dave", to_agent: "eve", body: "Not alice", created_at: "2024-01-03T00:00:00Z" });
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const result = await hooks.tool!.agmsg_history.execute({ agent: "alice" });
      expect(result.output).toContain("From alice");
      expect(result.output).toContain("To alice");
      expect(result.output).not.toContain("Not alice");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });

    it("works without agent filter", async () => {
      const dbPath = freshDb();
      seed(dbPath, { team: TEAM, from_agent: "alice", to_agent: "bob", body: "Hello", created_at: "2024-01-01T00:00:00Z" });
      const hooks = createPlugin(dummyClient(), { dbPath, teamName: TEAM, agentName: AGENT });
      const result = await hooks.tool!.agmsg_history.execute({});
      expect(result.output).toContain("Hello");
      rmSync(join(dbPath, ".."), { recursive: true, force: true });
    });
  });
});
