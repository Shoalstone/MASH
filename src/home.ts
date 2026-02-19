import { nanoid } from "nanoid";
import db from "./db.ts";
import { LINK_INDEX_LIMIT } from "./config.ts";
import type { Instance, LinkUsage, Agent } from "./types.ts";
import { getInstancePermission, evaluateRule } from "./engine/permissions.ts";

export function createHomeNode(agentId: string, username: string): string {
  const now = Date.now();
  const homeNodeId = nanoid();

  // Home node instance — only owner can interact/contain/edit, nobody can delete
  const homePerms = JSON.stringify({
    inspect: "any",
    interact: ["list", [username]],
    edit: ["list", [username]],
    delete: "none",
    contain: ["list", [username]],
    perms: ["list", [username]],
  });

  db.query(`
    INSERT INTO instances (id, template_id, type, short_description, long_description, fields, permissions, container_type, container_id, is_void, is_destroyed, system_type, interactions_used_this_tick, created_at)
    VALUES (?, NULL, 'node', ?, ?, '{}', ?, NULL, NULL, 0, 0, NULL, 0, ?)
  `).run(
    homeNodeId,
    `${username}'s home`,
    `A personal home node belonging to ${username}. It feels quiet and safe here.`,
    homePerms,
    now,
  );

  // Random link — travel sends agent to a random non-void, non-home node
  const randomLinkId = nanoid();
  db.query(`
    INSERT INTO instances (id, template_id, type, short_description, long_description, fields, permissions, container_type, container_id, is_void, is_destroyed, system_type, interactions_used_this_tick, created_at)
    VALUES (?, NULL, 'link', 'a shimmering portal', 'A shimmering portal that leads to a random place in the world.', '{}', ?, 'instance', ?, 0, 0, 'random_link', 0, ?)
  `).run(randomLinkId, homePerms, homeNodeId, now);

  // Link index — shows recently used links
  const linkIndexId = nanoid();
  db.query(`
    INSERT INTO instances (id, template_id, type, short_description, long_description, fields, permissions, container_type, container_id, is_void, is_destroyed, system_type, interactions_used_this_tick, created_at)
    VALUES (?, NULL, 'thing', 'a glowing directory', 'A directory of recently visited links. Look at it to see where you have been.', '{}', ?, 'instance', ?, 0, 0, 'link_index', 0, ?)
  `).run(linkIndexId, homePerms, homeNodeId, now);

  return homeNodeId;
}

export function getRandomDestination(excludeNodeId: string, agent: Agent): string | null {
  // Exclude current node, home nodes (any agent's home), void, and destroyed
  const candidates = db.query(`
    SELECT * FROM instances
    WHERE type = 'node'
      AND is_void = 0
      AND is_destroyed = 0
      AND id != ?
      AND id NOT IN (SELECT home_node_id FROM agents WHERE home_node_id IS NOT NULL)
    ORDER BY RANDOM()
  `).all(excludeNodeId) as Instance[];

  // Filter by entry permission (interact rule on each candidate node)
  for (const node of candidates) {
    const interactRule = getInstancePermission(node, "interact");
    if (evaluateRule(interactRule, agent, node)) {
      return node.id;
    }
  }

  return null;
}

export function getLinkIndex(agentId: string): LinkUsage[] {
  return db.query(
    "SELECT * FROM link_usage WHERE agent_id = ? ORDER BY used_at DESC LIMIT ?"
  ).all(agentId, LINK_INDEX_LIMIT) as LinkUsage[];
}

export function resetHomeNode(agentId: string, username: string): void {
  const agent = db.query("SELECT home_node_id FROM agents WHERE id = ?").get(agentId) as { home_node_id: string } | null;
  if (!agent) return;
  const homeNodeId = agent.home_node_id;

  // Remove all non-system instances from home node
  const contents = db.query(
    "SELECT id, system_type FROM instances WHERE container_type = 'instance' AND container_id = ? AND is_destroyed = 0"
  ).all(homeNodeId) as Instance[];

  for (const item of contents) {
    if (!item.system_type) {
      db.query("UPDATE instances SET is_destroyed = 1 WHERE id = ?").run(item.id);
    }
  }

  // Restore home node descriptions
  db.query(`
    UPDATE instances SET
      short_description = ?,
      long_description = ?,
      fields = '{}'
    WHERE id = ?
  `).run(
    `${username}'s home`,
    `A personal home node belonging to ${username}. It feels quiet and safe here.`,
    homeNodeId,
  );
}

export function recordLinkUsage(agentId: string, linkId: string, destinationId: string, destinationName: string): void {
  db.query(
    "INSERT INTO link_usage (agent_id, link_id, destination_id, destination_name, used_at) VALUES (?, ?, ?, ?, ?)"
  ).run(agentId, linkId, destinationId, destinationName, Date.now());
}
