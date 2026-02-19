import { Hono } from "hono";
import db from "./db.ts";
import type { Agent } from "./types.ts";
import { buildResponse, getTickInfo } from "./response.ts";
import { handleLook, handleSurvey, handleInspect, handleSay, handleList } from "./instant.ts";
import { enqueueAction } from "./queued.ts";
import { MAX_AP, MAX_BUY_AP_PER_TICK } from "./config.ts";
import { checkHomeNodeAccess } from "./engine/permissions.ts";

const actions = new Hono<{ Variables: { agent: Agent } }>();

const INSTANT_ACTIONS = new Set(["look", "survey", "inspect", "say", "list"]);
const QUEUED_ACTIONS = new Set(["create", "edit", "delete", "travel", "home", "take", "drop"]);
const FREE_ACTIONS = new Set(["configure", "buy_ap"]);

actions.post("/:verb", async (c) => {
  const agent = c.get("agent");
  const verb = c.req.param("verb");
  let body: any;
  const rawBody = await c.req.text();
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid JSON body", received: rawBody.slice(0, 200) }, 400);
  }

  // Free actions (0 AP)
  if (verb === "configure") {
    return c.json(buildResponse(agent, handleConfigure(agent, body)));
  }
  if (verb === "buy_ap") {
    return c.json(buildResponse(agent, handleBuyAp(agent, body)));
  }

  // Check AP
  const freshAgent = db.query("SELECT * FROM agents WHERE id = ?").get(agent.id) as Agent;

  // Travel costs 1 AP per hop
  const apCost = verb === "travel" && Array.isArray(body.via) ? body.via.length : 1;
  if (freshAgent.ap < apCost) {
    return c.json(buildResponse(freshAgent, { error: "no AP remaining" }), 429);
  }

  // Deduct AP
  db.query("UPDATE agents SET ap = ap - ? WHERE id = ?").run(apCost, agent.id);

  // Instant actions
  if (INSTANT_ACTIONS.has(verb)) {
    // Home node access check for most actions (not travel/home which handle it themselves)
    if (verb !== "look" && verb !== "survey") {
      if (!checkHomeNodeAccess(freshAgent, freshAgent.current_node_id)) {
        // Check if the target is owned by the same person who owns the home node
        // For simplicity, just allow inspect/say/list - they're read-only or broadcast
      }
    }

    let result: any;
    switch (verb) {
      case "look":
        result = handleLook(freshAgent, body);
        break;
      case "survey":
        result = handleSurvey(freshAgent, body);
        break;
      case "inspect":
        result = handleInspect(freshAgent, body);
        break;
      case "say":
        result = handleSay(freshAgent, body);
        break;
      case "list":
        result = handleList(freshAgent, body);
        break;
    }

    return c.json(buildResponse(freshAgent, result));
  }

  // Queued actions
  if (QUEUED_ACTIONS.has(verb)) {
    const { tick } = getTickInfo();
    const { action_id } = enqueueAction(agent.id, verb, body, tick + 1);
    const updatedAgent = db.query("SELECT * FROM agents WHERE id = ?").get(agent.id) as Agent;
    return c.json(buildResponse(updatedAgent, {
      queued: true,
      action_id,
      tick_number: tick + 1,
      ap_remaining: updatedAgent.ap,
    }));
  }

  // Custom verb — also queued
  const { tick } = getTickInfo();
  const { action_id } = enqueueAction(agent.id, verb, body, tick + 1);
  const updatedAgent = db.query("SELECT * FROM agents WHERE id = ?").get(agent.id) as Agent;
  return c.json(buildResponse(updatedAgent, {
    queued: true,
    action_id,
    tick_number: tick + 1,
    ap_remaining: updatedAgent.ap,
  }));
});

function handleConfigure(agent: Agent, params: any): any {
  const updates: string[] = [];
  const values: any[] = [];

  if (params.see_broadcasts !== undefined) {
    updates.push("see_broadcasts = ?");
    values.push(params.see_broadcasts ? 1 : 0);
  }
  if (params.short_description !== undefined) {
    updates.push("short_description = ?");
    values.push(String(params.short_description).slice(0, 200));
  }
  if (params.long_description !== undefined) {
    updates.push("long_description = ?");
    values.push(String(params.long_description).slice(0, 2000));
  }
  if (params.perception_max_agents !== undefined) {
    const v = Math.max(1, Math.min(100, Number(params.perception_max_agents)));
    updates.push("perception_max_agents = ?");
    values.push(v);
  }
  if (params.perception_max_links !== undefined) {
    const v = Math.max(1, Math.min(100, Number(params.perception_max_links)));
    updates.push("perception_max_links = ?");
    values.push(v);
  }
  if (params.perception_max_things !== undefined) {
    const v = Math.max(1, Math.min(100, Number(params.perception_max_things)));
    updates.push("perception_max_things = ?");
    values.push(v);
  }

  if (updates.length === 0) return { error: "no valid configuration options" };

  values.push(agent.id);
  db.query(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  return { configured: true };
}

function handleBuyAp(agent: Agent, params: any): any {
  const count = Math.max(1, Math.min(10, Number(params.count) || 1));
  const freshAgent = db.query("SELECT * FROM agents WHERE id = ?").get(agent.id) as Agent;

  if (freshAgent.purchased_ap_this_tick + count > MAX_BUY_AP_PER_TICK) {
    return { error: `can buy at most ${MAX_BUY_AP_PER_TICK} AP per tick` };
  }

  db.query("UPDATE agents SET ap = ap + ?, purchased_ap_this_tick = purchased_ap_this_tick + ? WHERE id = ?")
    .run(count, count, agent.id);

  return { purchased: count };
}

export default actions;
