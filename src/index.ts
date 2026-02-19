import { Hono } from "hono";
import db from "./db.ts";
import auth, { getAgentByToken } from "./auth.ts";
import actions from "./actions.ts";
import { buildResponse } from "./response.ts";
import { startTickLoop, waitForNextTick } from "./engine/tick.ts";
import { PORT } from "./config.ts";
import type { Agent } from "./types.ts";

const app = new Hono<{ Variables: { agent: Agent } }>();

// Health check
app.get("/health", (c) => {
  const tickRow = db.query("SELECT value FROM world_state WHERE key = 'tick_number'").get() as { value: string };
  return c.json({
    status: "ok",
    tick_number: Number(tickRow.value),
    uptime: process.uptime(),
  });
});

// Auth routes (unauthenticated)
app.route("/auth", auth);

// Auth middleware for everything below
app.use("/action/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);
  const agent = getAgentByToken(token);
  if (!agent) {
    return c.json({ error: "invalid token" }, 401);
  }
  c.set("agent", agent);
  await next();
});

app.use("/poll", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);
  const agent = getAgentByToken(token);
  if (!agent) {
    return c.json({ error: "invalid token" }, 401);
  }
  c.set("agent", agent);
  await next();
});

app.use("/wait", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);
  const agent = getAgentByToken(token);
  if (!agent) {
    return c.json({ error: "invalid token" }, 401);
  }
  c.set("agent", agent);
  await next();
});

// Poll endpoint
app.post("/poll", (c) => {
  const agent = c.get("agent") as Agent;
  return c.json(buildResponse(agent, {}));
});

// Wait endpoint — long-polls until the next tick completes
app.post("/wait", async (c) => {
  const agent = c.get("agent") as Agent;
  await waitForNextTick();
  // Re-fetch agent after tick (AP was reset, etc.)
  const freshAgent = getAgentByToken(agent.token!) as Agent;
  return c.json(buildResponse(freshAgent ?? agent, {}));
});

// Action routes
app.route("/action", actions);

// Error handler
app.onError((err, c) => {
  console.error("[error]", err);
  return c.json({ error: "internal server error" }, 500);
});

// 404
app.notFound((c) => {
  return c.json({ error: "not found" }, 404);
});

// Start tick loop
startTickLoop();

// Start server
console.log(`[mash] Starting on port ${PORT}`);
export default {
  port: PORT,
  fetch: app.fetch,
};
