import db from "../db.ts";
import { TICK_INTERVAL_MS, MAX_AP, EVENT_DELIVERED_TTL_MS, EVENT_UNDELIVERED_TTL_MS } from "../config.ts";
import type { Agent, ActionQueueEntry, Instance } from "../types.ts";
import { addEvent } from "../response.ts";
import { fireInteractions } from "./interactions.ts";
import { processCreate, processEdit, processDelete, processTravel, processHome, processTake, processDrop, processCustomVerb } from "../queued.ts";

let tickTimer: ReturnType<typeof setInterval> | null = null;

// Long-poll waiters: resolved when the next tick completes
const tickWaiters: Set<() => void> = new Set();

export function waitForNextTick(): Promise<void> {
  return new Promise((resolve) => {
    tickWaiters.add(resolve);
  });
}

function resolveTickWaiters(): void {
  for (const resolve of tickWaiters) {
    resolve();
  }
  tickWaiters.clear();
}

export function startTickLoop(): void {
  if (tickTimer) return;
  console.log(`[tick] Starting tick loop (${TICK_INTERVAL_MS}ms interval)`);
  tickTimer = setInterval(processTick, TICK_INTERVAL_MS);
}

export function stopTickLoop(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export function processTick(): void {
  const startTime = Date.now();

  try {
    // Increment tick number
    const tickRow = db.query("SELECT value FROM world_state WHERE key = 'tick_number'").get() as { value: string };
    const tickNumber = Number(tickRow.value) + 1;
    db.query("UPDATE world_state SET value = ? WHERE key = 'tick_number'").run(String(tickNumber));
    db.query("UPDATE world_state SET value = ? WHERE key = 'last_tick_at'").run(String(Date.now()));

    // Phase 1: Reset AP + interaction counters
    db.query(`UPDATE agents SET ap = ${MAX_AP}, purchased_ap_this_tick = 0`).run();
    db.query("UPDATE instances SET interactions_used_this_tick = 0").run();

    // Phase 2: Fire "tick" verb on objects in occupied nodes
    const occupiedNodes = db.query(
      "SELECT DISTINCT current_node_id FROM agents"
    ).all() as { current_node_id: string }[];

    for (const { current_node_id } of occupiedNodes) {
      const instances = db.query(
        "SELECT * FROM instances WHERE container_type = 'instance' AND container_id = ? AND is_void = 0 AND is_destroyed = 0 ORDER BY created_at"
      ).all(current_node_id) as Instance[];

      for (const instance of instances) {
        try {
          fireInteractions(instance, "tick", null, null);
        } catch (err: any) {
          console.error(`[tick] Error firing tick on instance ${instance.id}:`, err.message || err);
        }
      }
    }

    // Phase 3: Process action queue
    const actions = db.query(
      "SELECT * FROM action_queue WHERE tick_number <= ? ORDER BY id"
    ).all(tickNumber) as ActionQueueEntry[];

    for (const action of actions) {
      const agent = db.query("SELECT * FROM agents WHERE id = ?").get(action.agent_id) as Agent | null;
      if (!agent) {
        db.query("DELETE FROM action_queue WHERE id = ?").run(action.id);
        continue;
      }

      const params = JSON.parse(action.params);
      let result: any;

      try {
        switch (action.action) {
          case "create":
            result = processCreate(agent, params);
            break;
          case "edit":
            result = processEdit(agent, params);
            break;
          case "delete":
            result = processDelete(agent, params);
            break;
          case "travel":
            result = processTravel(agent, params);
            break;
          case "home":
            result = processHome(agent);
            break;
          case "take":
            result = processTake(agent, params);
            break;
          case "drop":
            result = processDrop(agent, params);
            break;
          default:
            // Custom verb
            result = processCustomVerb(agent, action.action, params);
            break;
        }
      } catch (err: any) {
        result = { error: err.message || "internal error" };
      }

      // Store result as event for the agent
      addEvent(agent.id, "action_result", {
        action: action.action,
        action_id: action.id,
        result,
      });

      db.query("DELETE FROM action_queue WHERE id = ?").run(action.id);
    }

    // Phase 4: Cleanup old events
    const now = Date.now();
    // Events that have been delivered (consumed) won't exist, but clean up any lingering ones
    db.query("DELETE FROM events WHERE created_at < ?").run(now - EVENT_UNDELIVERED_TTL_MS);

    const elapsed = Date.now() - startTime;
    if (elapsed > 1000) {
      console.log(`[tick] Tick ${tickNumber} took ${elapsed}ms`);
    }

    // Unblock any long-polling /wait connections
    resolveTickWaiters();
  } catch (err) {
    console.error("[tick] Error during tick:", err);
    // Still unblock waiters on error so they don't hang
    resolveTickWaiters();
  }
}
