import db from "./db.ts";
import { MAX_EVENTS_PER_RESPONSE, TICK_INTERVAL_MS } from "./config.ts";
import type { Agent, ApiResponse, Event } from "./types.ts";

export function getTickInfo(): { tick: number; lastTickAt: number } {
  const tickRow = db.query("SELECT value FROM world_state WHERE key = 'tick_number'").get() as { value: string } | null;
  const lastTickRow = db.query("SELECT value FROM world_state WHERE key = 'last_tick_at'").get() as { value: string } | null;
  return {
    tick: tickRow ? Number(tickRow.value) : 0,
    lastTickAt: lastTickRow ? Number(lastTickRow.value) : Date.now(),
  };
}

export function buildResponse<T>(agent: Agent, result: T): ApiResponse<T> {
  const { tick, lastTickAt } = getTickInfo();
  const nextTickInMs = Math.max(0, lastTickAt + TICK_INTERVAL_MS - Date.now());

  // Fetch and consume events for this agent
  const events = db.query(
    "SELECT * FROM events WHERE agent_id = ? ORDER BY id LIMIT ?"
  ).all(agent.id, MAX_EVENTS_PER_RESPONSE) as Event[];

  if (events.length > 0) {
    const maxId = events[events.length - 1]!.id;
    db.query("DELETE FROM events WHERE agent_id = ? AND id <= ?").run(agent.id, maxId);
  }

  // Refresh AP from db in case it changed
  const freshAgent = db.query("SELECT ap, purchased_ap_this_tick FROM agents WHERE id = ?").get(agent.id) as { ap: number; purchased_ap_this_tick: number };

  return {
    info: {
      tick,
      next_tick_in_ms: nextTickInMs,
      ap: freshAgent.ap,
      purchased_ap_this_tick: freshAgent.purchased_ap_this_tick,
      events: events.map((e) => ({
        type: e.type,
        data: JSON.parse(e.data),
        created_at: e.created_at,
      })),
    },
    result,
  };
}

export function addEvent(agentId: string, type: string, data: any): void {
  db.query(
    "INSERT INTO events (agent_id, type, data, created_at) VALUES (?, ?, ?, ?)"
  ).run(agentId, type, JSON.stringify(data), Date.now());
}

export function broadcastToNode(nodeId: string, type: string, data: any, excludeAgentId?: string): void {
  const agents = db.query(
    "SELECT id FROM agents WHERE current_node_id = ? AND see_broadcasts = 1"
  ).all(nodeId) as { id: string }[];

  for (const a of agents) {
    if (a.id !== excludeAgentId) {
      addEvent(a.id, type, data);
    }
  }
}
