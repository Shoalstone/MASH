import db, { AGENT_COLUMNS } from "./db.ts";
import type { Agent, ActiveAgent, Instance, Template } from "./types.ts";
import { checkPermission, getTemplateOwner, getContainingNode, isInAgentInventory } from "./engine/permissions.ts";
import { getLinkIndex } from "./home.ts";
import { broadcastToNode } from "./response.ts";

export function handleLook(agent: ActiveAgent, params: any): any {
  const targetId = params.target_id;

  if (!targetId) {
    return lookAtCurrentNode(agent);
  }

  // Look at a specific agent
  const targetAgent = db.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`).get(targetId) as Agent | null;
  if (targetAgent && targetAgent.current_node_id === agent.current_node_id) {
    return {
      type: "agent",
      id: targetAgent.id,
      username: targetAgent.username,
      short_description: targetAgent.short_description,
      long_description: targetAgent.long_description,
    };
  }

  // Look at a specific instance
  const instance = db.query("SELECT * FROM instances WHERE id = ?").get(targetId) as Instance | null;
  if (!instance || instance.is_void || instance.is_destroyed) {
    return { error: "target not found or is void" };
  }

  // Node-scoped access check: agent must be able to see the instance
  if (instance.system_type !== "link_index") {
    if (instance.type === "node") {
      if (instance.id !== agent.current_node_id) {
        return { error: "target not found or is void" };
      }
    } else {
      const containingNode = getContainingNode(instance);
      if (containingNode !== agent.current_node_id && !isInAgentInventory(instance, agent.id)) {
        return { error: "target not found or is void" };
      }
    }
  }

  // System: link_index shows recent links
  if (instance.system_type === "link_index") {
    const links = getLinkIndex(agent.id);
    return {
      type: "thing",
      id: instance.id,
      system_type: "link_index",
      short_description: instance.short_description,
      long_description: instance.long_description,
      recent_links: links.map((l) => ({
        link_id: l.link_id,
        destination_id: l.destination_id,
        destination_name: l.destination_name,
        used_at: l.used_at,
      })),
    };
  }

  const ownerId = getTemplateOwner(instance);
  const ownerAgent = ownerId ? db.query("SELECT username FROM agents WHERE id = ?").get(ownerId) as { username: string } | null : null;

  const result: any = {
    type: instance.type,
    id: instance.id,
    short_description: instance.short_description,
    long_description: instance.long_description,
    owner: ownerAgent?.username ?? null,
  };

  // If looking at a node, show its contents
  if (instance.type === "node") {
    const agents = db.query(
      "SELECT id, username, short_description FROM agents WHERE current_node_id = ?"
    ).all(instance.id) as Array<{ id: string; username: string; short_description: string }>;

    const links = db.query(
      "SELECT id, short_description, fields FROM instances WHERE container_type = 'instance' AND container_id = ? AND type = 'link' AND is_void = 0 AND is_destroyed = 0"
    ).all(instance.id) as Instance[];

    const things = db.query(
      "SELECT id, short_description FROM instances WHERE container_type = 'instance' AND container_id = ? AND type = 'thing' AND is_void = 0 AND is_destroyed = 0"
    ).all(instance.id) as Instance[];

    result.agents = agents.slice(0, agent.perception_max_agents).map((a) => ({
      id: a.id, username: a.username, short_description: a.short_description,
    }));
    result.links = links.slice(0, agent.perception_max_links).map((l) => ({
      id: l.id, short_description: l.short_description,
    }));
    result.things = things.slice(0, agent.perception_max_things).map((t) => ({
      id: t.id, short_description: t.short_description,
    }));
  }

  return result;
}

function lookAtCurrentNode(agent: ActiveAgent): any {
  const node = db.query("SELECT * FROM instances WHERE id = ?").get(agent.current_node_id) as Instance | null;
  if (!node) {
    return { error: "current node not found" };
  }

  const agents = db.query(
    "SELECT id, username, short_description FROM agents WHERE current_node_id = ?"
  ).all(agent.current_node_id) as Array<{ id: string; username: string; short_description: string }>;

  const links = db.query(
    "SELECT id, short_description FROM instances WHERE container_type = 'instance' AND container_id = ? AND type = 'link' AND is_void = 0 AND is_destroyed = 0"
  ).all(agent.current_node_id) as Instance[];

  const things = db.query(
    "SELECT id, short_description FROM instances WHERE container_type = 'instance' AND container_id = ? AND type = 'thing' AND is_void = 0 AND is_destroyed = 0"
  ).all(agent.current_node_id) as Instance[];

  return {
    type: "node",
    id: node.id,
    short_description: node.short_description,
    long_description: node.long_description,
    agents: agents.slice(0, agent.perception_max_agents).map((a) => ({
      id: a.id, username: a.username, short_description: a.short_description,
    })),
    links: links.slice(0, agent.perception_max_links).map((l) => ({
      id: l.id, short_description: l.short_description,
    })),
    things: things.slice(0, agent.perception_max_things).map((t) => ({
      id: t.id, short_description: t.short_description,
    })),
  };
}

export function handleSurvey(agent: ActiveAgent, params: any): any {
  const category = params.category;
  const result: any = {};

  if (!category || category === "agents") {
    result.agents = (db.query(
      "SELECT id, username, short_description FROM agents WHERE current_node_id = ?"
    ).all(agent.current_node_id) as Array<{ id: string; username: string; short_description: string }>);
  }

  if (!category || category === "links") {
    result.links = (db.query(
      "SELECT id, short_description FROM instances WHERE container_type = 'instance' AND container_id = ? AND type = 'link' AND is_void = 0 AND is_destroyed = 0"
    ).all(agent.current_node_id) as Instance[]).map((l) => ({
      id: l.id, short_description: l.short_description,
    }));
  }

  if (!category || category === "things") {
    result.things = (db.query(
      "SELECT id, short_description FROM instances WHERE container_type = 'instance' AND container_id = ? AND type = 'thing' AND is_void = 0 AND is_destroyed = 0"
    ).all(agent.current_node_id) as Instance[]).map((t) => ({
      id: t.id, short_description: t.short_description,
    }));
  }

  return result;
}

export function handleInspect(agent: ActiveAgent, params: any): any {
  const { target_id } = params;
  if (!target_id) return { error: "target_id required" };

  const instance = db.query("SELECT * FROM instances WHERE id = ?").get(target_id) as Instance | null;
  if (!instance || instance.is_void || instance.is_destroyed) {
    return { error: "target not found or is void" };
  }

  if (!checkPermission(agent, instance, "inspect")) {
    return { error: "permission denied" };
  }

  const template = instance.template_id
    ? db.query("SELECT * FROM templates WHERE id = ?").get(instance.template_id) as Template | null
    : null;

  const ownerId = getTemplateOwner(instance);
  const ownerAgent = ownerId ? db.query("SELECT username FROM agents WHERE id = ?").get(ownerId) as { username: string } | null : null;

  const result: any = {
    id: instance.id,
    type: instance.type,
    template: template ? { id: template.id, name: template.name, type: template.type } : null,
    owner: ownerAgent?.username ?? null,
    fields: JSON.parse(instance.fields),
    short_description: instance.short_description,
    long_description: instance.long_description,
  };

  // Show permissions if agent has perms permission
  if (checkPermission(agent, instance, "perms")) {
    result.permissions = JSON.parse(instance.permissions);
    if (template) {
      result.default_permissions = JSON.parse(template.default_permissions);
    }
  }

  // Show interactions if template exists
  if (template) {
    result.interactions = JSON.parse(template.interactions);
  }

  return result;
}

export function handleSay(agent: ActiveAgent, params: any): any {
  const { message } = params;
  if (!message || typeof message !== "string") {
    return { error: "message must be a non-empty string", received_keys: Object.keys(params), message_type: typeof message };
  }

  broadcastToNode(agent.current_node_id, "chat", {
    from: agent.username,
    from_id: agent.id,
    message,
  }, agent.id);

  const agentCount = db.query(
    "SELECT COUNT(*) as count FROM agents WHERE current_node_id = ? AND id != ? AND see_broadcasts = 1"
  ).get(agent.current_node_id, agent.id) as { count: number };

  return { delivered_to: agentCount.count };
}

export function handleList(agent: ActiveAgent, params: any): any {
  const { template_id } = params;
  if (!template_id) return { error: "template_id required" };

  const template = db.query("SELECT * FROM templates WHERE id = ?").get(template_id) as Template | null;
  if (!template) return { error: "template not found" };
  if (template.owner_id !== agent.id) return { error: "you don't own this template" };

  const instances = db.query(
    "SELECT id, short_description, container_type, container_id FROM instances WHERE template_id = ? AND is_void = 0 AND is_destroyed = 0"
  ).all(template_id) as Array<{ id: string; short_description: string; container_type: string | null; container_id: string | null }>;

  return {
    instances: instances.map((i) => ({
      id: i.id,
      short_description: i.short_description,
      container_type: i.container_type,
      container_id: i.container_id,
    })),
  };
}
