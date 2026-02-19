import { Hono } from "hono";
import { nanoid } from "nanoid";
import db, { AGENT_COLUMNS } from "./db.ts";
import type { Agent, AgentWithHash } from "./types.ts";
import { createHomeNode } from "./home.ts";
import { rateLimit } from "./ratelimit.ts";

const auth = new Hono();

auth.use("/*", rateLimit());

auth.post("/signup", async (c) => {
  const body = await c.req.json();
  const { username, password } = body;

  if (!username || typeof username !== "string" || username.length < 1 || username.length > 32) {
    return c.json({ error: "username must be 1-32 characters" }, 400);
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    return c.json({ error: "password must be at least 6 characters" }, 400);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return c.json({ error: "username must be alphanumeric (underscores allowed)" }, 400);
  }

  const existing = db.query("SELECT id FROM agents WHERE username = ?").get(username);
  if (existing) {
    return c.json({ error: "username already taken" }, 409);
  }

  const agentId = nanoid();
  const token = nanoid(32);
  const passwordHash = await Bun.password.hash(password);
  const now = Date.now();

  // Create home node first so we have the ID
  const homeNodeId = createHomeNode(agentId, username);

  db.query(`
    INSERT INTO agents (id, username, password_hash, token, current_node_id, home_node_id, ap, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 4, ?)
  `).run(agentId, username, passwordHash, token, homeNodeId, homeNodeId, now);

  return c.json({
    info: null,
    result: { agent_id: agentId, token, home_node_id: homeNodeId },
  });
});

auth.post("/login", async (c) => {
  const body = await c.req.json();
  const { username, password } = body;

  if (!username || !password) {
    return c.json({ error: "username and password required" }, 400);
  }

  const agent = db.query("SELECT id, password_hash FROM agents WHERE username = ?").get(username) as AgentWithHash | null;
  if (!agent) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const valid = await Bun.password.verify(password, agent.password_hash);
  if (!valid) {
    return c.json({ error: "invalid credentials" }, 401);
  }

  const token = nanoid(32);
  db.query("UPDATE agents SET token = ? WHERE id = ?").run(token, agent.id);

  return c.json({
    info: null,
    result: { agent_id: agent.id, token },
  });
});

export function getAgentByToken(token: string): Agent | null {
  return db.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE token = ?`).get(token) as Agent | null;
}

export default auth;
