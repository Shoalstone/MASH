import db, { AGENT_COLUMNS } from "../db.ts";
import { TICK_INTERVAL_MS, MAX_AP, EVENT_DELIVERED_TTL_MS, EVENT_UNDELIVERED_TTL_MS, IDLE_TIMEOUT_MS } from "../config.ts";
import type { Agent, ActiveAgent, ActionQueueEntry, Instance } from "../types.ts";
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
    db.query(`UPDATE agents SET ap = ${MAX_AP}`).run();
    db.query("UPDATE instances SET interactions_used_this_tick = 0").run();

    // Phase 2: Send idle agents to limbo
    const idleCutoff = Date.now() - IDLE_TIMEOUT_MS;
    const idleAgents = db.query(
      `SELECT ${AGENT_COLUMNS} FROM agents WHERE current_node_id IS NOT NULL AND last_active_at < ?`
    ).all(idleCutoff) as Agent[];
    for (const agent of idleAgents) {
      db.query("UPDATE agents SET current_node_id = NULL WHERE id = ?").run(agent.id);
      addEvent(agent.id, "system", { message: "You drift off into a deep sleep." });
    }

    // Phase 3: Fire "tick" verb on objects in occupied nodes
    const occupiedNodes = db.query(
      "SELECT DISTINCT current_node_id FROM agents WHERE current_node_id IS NOT NULL"
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

    // Phase 4: Process action queue
    const actions = db.query(
      "SELECT * FROM action_queue WHERE tick_number <= ? ORDER BY id"
    ).all(tickNumber) as ActionQueueEntry[];

    for (const action of actions) {
      const agent = db.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`).get(action.agent_id) as Agent | null;
      if (!agent || !agent.current_node_id) {
        db.query("DELETE FROM action_queue WHERE id = ?").run(action.id);
        continue;
      }
      const activeAgent = agent as ActiveAgent;

      const params = JSON.parse(action.params);
      let result: any;

      try {
        switch (action.action) {
          case "create":
            result = processCreate(activeAgent, params);
            break;
          case "edit":
            result = processEdit(activeAgent, params);
            break;
          case "delete":
            result = processDelete(activeAgent, params);
            break;
          case "travel":
            result = processTravel(activeAgent, params);
            break;
          case "home":
            result = processHome(activeAgent);
            break;
          case "take":
            result = processTake(activeAgent, params);
            break;
          case "drop":
            result = processDrop(activeAgent, params);
            break;
          default:
            // Custom verb
            result = processCustomVerb(activeAgent, action.action, params);
            break;
        }
      } catch (err: any) {
        console.error(`[tick] Error processing action ${action.action} for agent ${action.agent_id}:`, err);
        result = { error: "action failed" };
      }

      // Store result as event for the agent
      addEvent(activeAgent.id, "action_result", {
        action: action.action,
        action_id: action.id,
        result,
      });

      db.query("DELETE FROM action_queue WHERE id = ?").run(action.id);
    }

    // Phase 5: Cleanup old events
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
