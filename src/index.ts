import { Hono } from "hono";
import db from "./db.ts";
import auth, { getAgentByToken } from "./auth.ts";
import actions from "./actions.ts";
import { buildResponse, addEvent } from "./response.ts";
import { startTickLoop, waitForNextTick } from "./engine/tick.ts";
import { PORT } from "./config.ts";
import type { Agent, ActiveAgent } from "./types.ts";

const app = new Hono<{ Variables: { agent: ActiveAgent } }>();

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
async function authenticate(c: any, next: any) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "missing or invalid Authorization header" }, 401);
  }
  const token = authHeader.slice(7);
  let agent = getAgentByToken(token);
  if (!agent) {
    return c.json({ error: "invalid token" }, 401);
  }

  // Track activity
  const now = Date.now();
  db.query("UPDATE agents SET last_active_at = ? WHERE id = ?").run(now, agent.id);

  // Wake from limbo
  if (!agent.current_node_id) {
    db.query("UPDATE agents SET current_node_id = ? WHERE id = ?").run(agent.home_node_id, agent.id);
    addEvent(agent.id, "system", { message: "You wake up at home." });
    agent = getAgentByToken(token)!;
  }

  c.set("agent", agent as ActiveAgent);
  await next();
}

app.use("/action/*", authenticate);
app.use("/poll", authenticate);
app.use("/wait", authenticate);

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
  fetch(req: Request, server: any) {
    const ip = server.requestIP(req);
    if (ip) {
      req.headers.set("X-Real-IP", ip.address);
    }
    return app.fetch(req, server);
  },
};
