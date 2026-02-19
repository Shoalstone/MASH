import { nanoid } from "nanoid";
import db from "./db.ts";
import { MAX_CONTAINMENT_DEPTH } from "./config.ts";
import type { Agent, Instance, Template, Permissions, PermissionKey } from "./types.ts";
import { checkPermission, getTemplateOwner, checkContainmentDepth, getContainingNode } from "./engine/permissions.ts";
import { addEvent, broadcastToNode } from "./response.ts";
import { getRandomDestination, recordLinkUsage, resetHomeNode } from "./home.ts";
import { fireInteractions } from "./engine/interactions.ts";

// --- Queue insertion (called at request time) ---

export function enqueueAction(agentId: string, action: string, params: any, tickNumber: number): { action_id: number } {
  const result = db.query(
    "INSERT INTO action_queue (agent_id, action, params, tick_number, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(agentId, action, JSON.stringify(params), tickNumber, Date.now());
  return { action_id: Number(result.lastInsertRowid) };
}

function refundAp(agent: Agent, amount: number): void {
  if (amount > 0) {
    db.query("UPDATE agents SET ap = ap + ? WHERE id = ?").run(amount, agent.id);
  }
}

// --- Action processors (called during tick) ---

export function processCreate(agent: Agent, params: any): any {
  const { type } = params;

  if (type === "template") {
    return createTemplate(agent, params);
  } else if (type === "instance") {
    return createInstance(agent, params);
  }
  return { error: "type must be 'template' or 'instance'" };
}

function createTemplate(agent: Agent, params: any): any {
  const { name, template_type, short_description, long_description, fields, default_permissions, interactions } = params;
  if (!name || !template_type) return { error: "name and template_type required" };
  if (!["node", "link", "thing"].includes(template_type)) return { error: "template_type must be node, link, or thing" };

  const id = nanoid();
  const now = Date.now();
  db.query(`
    INSERT INTO templates (id, owner_id, name, type, short_description, long_description, fields, default_permissions, interactions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, agent.id, name, template_type,
    short_description || "", long_description || "",
    JSON.stringify(fields || {}),
    JSON.stringify(default_permissions || { inspect: "any", interact: "any", edit: "owner", delete: "owner", contain: "owner", perms: "owner" }),
    JSON.stringify(interactions || []),
    now,
  );

  return { template_id: id };
}

function createInstance(agent: Agent, params: any): any {
  const { template_id, container_id, fields: fieldOverrides } = params;
  if (!template_id) return { error: "template_id required" };

  const template = db.query("SELECT * FROM templates WHERE id = ?").get(template_id) as Template | null;
  if (!template) return { error: "template not found" };
  if (template.owner_id !== agent.id) return { error: "you don't own this template" };

  // Determine container
  let containerType: string | null = null;
  let containerId: string | null = null;

  if (template.type === "node") {
    // Nodes are top-level, no container
    containerType = null;
    containerId = null;
  } else if (container_id) {
    // Place in specified container
    const container = db.query("SELECT * FROM instances WHERE id = ?").get(container_id) as Instance | null;
    if (!container || container.is_void || container.is_destroyed) return { error: "container not found" };
    if (!checkPermission(agent, container, "contain")) return { error: "no contain permission on target container" };
    if (!checkContainmentDepth(container_id)) return { error: "containment depth exceeded" };
    containerType = "instance";
    containerId = container_id;
  } else {
    // Default: place in agent's current node
    containerType = "instance";
    containerId = agent.current_node_id;
  }

  const id = nanoid();
  const now = Date.now();
  const templateFields = JSON.parse(template.fields);
  const mergedFields = { ...templateFields, ...(fieldOverrides || {}) };

  db.query(`
    INSERT INTO instances (id, template_id, type, short_description, long_description, fields, permissions, container_type, container_id, is_void, is_destroyed, system_type, interactions_used_this_tick, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, 0, 0, NULL, 0, ?)
  `).run(
    id, template.id, template.type,
    template.short_description, template.long_description,
    JSON.stringify(mergedFields),
    containerType, containerId,
    now,
  );

  return { instance_id: id };
}

export function processEdit(agent: Agent, params: any): any {
  const { target_type, target_id, changes } = params;
  if (!target_id || !changes) return { error: "target_id and changes required" };

  if (target_type === "template") {
    return editTemplate(agent, target_id, changes);
  } else if (target_type === "instance") {
    return editInstance(agent, target_id, changes);
  }
  return { error: "target_type must be 'template' or 'instance'" };
}

function editTemplate(agent: Agent, templateId: string, changes: any): any {
  const template = db.query("SELECT * FROM templates WHERE id = ?").get(templateId) as Template | null;
  if (!template) return { error: "template not found" };
  if (template.owner_id !== agent.id) return { error: "you don't own this template" };

  const updates: string[] = [];
  const values: any[] = [];

  if (changes.name !== undefined) { updates.push("name = ?"); values.push(changes.name); }
  if (changes.short_description !== undefined) { updates.push("short_description = ?"); values.push(changes.short_description); }
  if (changes.long_description !== undefined) { updates.push("long_description = ?"); values.push(changes.long_description); }
  if (changes.fields !== undefined) { updates.push("fields = ?"); values.push(JSON.stringify(changes.fields)); }
  if (changes.default_permissions !== undefined) { updates.push("default_permissions = ?"); values.push(JSON.stringify(changes.default_permissions)); }
  if (changes.interactions !== undefined) { updates.push("interactions = ?"); values.push(JSON.stringify(changes.interactions)); }

  if (updates.length === 0) return { error: "no valid changes" };

  values.push(templateId);
  db.query(`UPDATE templates SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  return { updated: true };
}

function editInstance(agent: Agent, instanceId: string, changes: any): any {
  const instance = db.query("SELECT * FROM instances WHERE id = ?").get(instanceId) as Instance | null;
  if (!instance || instance.is_void || instance.is_destroyed) return { error: "instance not found or is void" };

  if (!checkPermission(agent, instance, "edit")) return { error: "no edit permission" };

  const updates: string[] = [];
  const values: any[] = [];

  if (changes.short_description !== undefined) { updates.push("short_description = ?"); values.push(changes.short_description); }
  if (changes.long_description !== undefined) { updates.push("long_description = ?"); values.push(changes.long_description); }
  if (changes.fields !== undefined) {
    const existingFields = JSON.parse(instance.fields);
    const merged = { ...existingFields, ...changes.fields };
    updates.push("fields = ?");
    values.push(JSON.stringify(merged));
  }
  if (changes.permissions !== undefined) {
    if (!checkPermission(agent, instance, "perms")) return { error: "no perms permission" };
    const existingPerms: Permissions = JSON.parse(instance.permissions);
    const merged = { ...existingPerms, ...changes.permissions };
    updates.push("permissions = ?");
    values.push(JSON.stringify(merged));
  }

  if (updates.length === 0) return { error: "no valid changes" };

  values.push(instanceId);
  db.query(`UPDATE instances SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  return { updated: true };
}

export function processDelete(agent: Agent, params: any): any {
  const { target_id } = params;
  if (!target_id) return { error: "target_id required" };

  // Check if it's a template
  const template = db.query("SELECT * FROM templates WHERE id = ?").get(target_id) as Template | null;
  if (template) {
    if (template.owner_id !== agent.id) return { error: "you don't own this template" };
    return deleteTemplate(target_id);
  }

  // Check if it's an instance
  const instance = db.query("SELECT * FROM instances WHERE id = ?").get(target_id) as Instance | null;
  if (!instance || instance.is_destroyed) return { error: "target not found" };
  if (!checkPermission(agent, instance, "delete")) return { error: "no delete permission" };

  return deleteInstance(instance);
}

function deleteTemplate(templateId: string): any {
  // Void all instances of this template
  const instances = db.query(
    "SELECT * FROM instances WHERE template_id = ? AND is_void = 0"
  ).all(templateId) as Instance[];

  for (const inst of instances) {
    db.query("UPDATE instances SET is_void = 1, template_id = NULL WHERE id = ?").run(inst.id);
    handleVoidCascade(inst);
  }

  db.query("DELETE FROM templates WHERE id = ?").run(templateId);
  return { deleted: true, voided_instances: instances.length };
}

function deleteInstance(instance: Instance): any {
  db.query("UPDATE instances SET is_destroyed = 1 WHERE id = ?").run(instance.id);
  handleVoidCascade(instance);
  return { deleted: true };
}

function handleVoidCascade(instance: Instance): void {
  // Move agents in void/destroyed nodes to their homes
  if (instance.type === "node") {
    const agents = db.query(
      "SELECT * FROM agents WHERE current_node_id = ?"
    ).all(instance.id) as Agent[];

    for (const a of agents) {
      db.query("UPDATE agents SET current_node_id = ? WHERE id = ?").run(a.home_node_id, a.id);
      addEvent(a.id, "system", { message: "The node you were in has been destroyed. You have been sent home." });
    }
  }

  // Destroy contained things
  const contained = db.query(
    "SELECT * FROM instances WHERE container_type = 'instance' AND container_id = ? AND is_destroyed = 0"
  ).all(instance.id) as Instance[];

  for (const item of contained) {
    db.query("UPDATE instances SET is_destroyed = 1 WHERE id = ?").run(item.id);
    handleVoidCascade(item);
  }
}

export function processTravel(agent: Agent, params: any): any {
  const { via } = params;
  if (!via) return { error: "via required (link id or array of link ids)" };

  const linkIds = Array.isArray(via) ? via : [via];
  if (linkIds.length === 0) return { error: "via must not be empty" };

  let currentNodeId = agent.current_node_id;

  for (let i = 0; i < linkIds.length; i++) {
    const linkId = linkIds[i]!;
    const fromNodeId = currentNodeId;

    const link = db.query("SELECT * FROM instances WHERE id = ? AND type = 'link'").get(linkId) as Instance | null;
    if (!link || link.is_void || link.is_destroyed) {
      refundAp(agent, linkIds.length - i);
      return { error: `link ${linkId} not found or is void` };
    }

    // Link must be in agent's current node
    if (link.container_type !== "instance" || link.container_id !== currentNodeId) {
      refundAp(agent, linkIds.length - i);
      return { error: `link ${linkId} is not in your current node` };
    }

    // Determine destination
    let destinationId: string | null;
    if (link.system_type === "random_link") {
      destinationId = getRandomDestination(currentNodeId);
      if (!destinationId) {
        refundAp(agent, linkIds.length - i);
        return { error: "no available destinations" };
      }
    } else {
      const fields = JSON.parse(link.fields);
      destinationId = fields.destination;
      if (!destinationId) {
        refundAp(agent, linkIds.length - i);
        return { error: `link ${linkId} has no destination` };
      }
    }

    // Verify destination exists and isn't void
    const destNode = db.query("SELECT * FROM instances WHERE id = ? AND type = 'node' AND is_void = 0 AND is_destroyed = 0").get(destinationId) as Instance | null;
    if (!destNode) {
      refundAp(agent, linkIds.length - i);
      return { error: "destination node not found or is void" };
    }

    // Fire travel on link
    if (fireInteractions(link, "travel", agent, null)) {
      refundAp(agent, linkIds.length - i - 1);
      return { error: `travel denied by ${link.short_description}`, stopped_at: currentNodeId };
    }

    // Fire exit on departing node
    const fromNode = db.query("SELECT * FROM instances WHERE id = ?").get(fromNodeId) as Instance | null;
    if (fromNode && fireInteractions(fromNode, "exit", agent, null)) {
      refundAp(agent, linkIds.length - i - 1);
      return { error: "exit denied by node", stopped_at: currentNodeId };
    }

    // Fire enter on destination node
    if (fireInteractions(destNode, "enter", agent, null)) {
      refundAp(agent, linkIds.length - i - 1);
      return { error: "entry denied by destination node", stopped_at: currentNodeId };
    }

    // Move agent to this hop's destination
    const destName = destNode.short_description || "";
    recordLinkUsage(agent.id, linkId, destinationId, destName);
    currentNodeId = destinationId;
    db.query("UPDATE agents SET current_node_id = ? WHERE id = ?").run(currentNodeId, agent.id);
    generateTravelEvents(agent, fromNodeId, currentNodeId);
  }

  // Generate perception for the final position
  const perception = generatePerception(agent, currentNodeId);

  return { arrived_at: currentNodeId, perception };
}

function generateTravelEvents(agent: Agent, fromNodeId: string, toNodeId: string): void {
  broadcastToNode(fromNodeId, "broadcast", {
    message: `${agent.username} has left.`,
  }, agent.id);

  broadcastToNode(toNodeId, "broadcast", {
    message: `${agent.username} has arrived.`,
  }, agent.id);
}

function generatePerception(agent: Agent, nodeId: string): any {
  const node = db.query("SELECT * FROM instances WHERE id = ?").get(nodeId) as Instance | null;
  if (!node) return {};

  const agents = db.query(
    "SELECT id, username, short_description FROM agents WHERE current_node_id = ? AND id != ?"
  ).all(nodeId, agent.id) as Array<{ id: string; username: string; short_description: string }>;

  const links = db.query(
    "SELECT id, short_description FROM instances WHERE container_type = 'instance' AND container_id = ? AND type = 'link' AND is_void = 0 AND is_destroyed = 0"
  ).all(nodeId) as Instance[];

  const things = db.query(
    "SELECT id, short_description FROM instances WHERE container_type = 'instance' AND container_id = ? AND type = 'thing' AND is_void = 0 AND is_destroyed = 0"
  ).all(nodeId) as Instance[];

  return {
    node: { id: node.id, short_description: node.short_description, long_description: node.long_description },
    agents: agents.slice(0, agent.perception_max_agents),
    links: links.slice(0, agent.perception_max_links).map((l) => ({ id: l.id, short_description: l.short_description })),
    things: things.slice(0, agent.perception_max_things).map((t) => ({ id: t.id, short_description: t.short_description })),
  };
}

export function processHome(agent: Agent): any {
  const originNodeId = agent.current_node_id;
  if (originNodeId === agent.home_node_id) {
    return { error: "you are already home" };
  }

  db.query("UPDATE agents SET current_node_id = ? WHERE id = ?").run(agent.home_node_id, agent.id);
  generateTravelEvents(agent, originNodeId, agent.home_node_id);

  const perception = generatePerception(agent, agent.home_node_id);
  return { arrived_at: agent.home_node_id, perception };
}

export function processTake(agent: Agent, params: any): any {
  const { target_id, into } = params;
  if (!target_id) return { error: "target_id required" };

  const thing = db.query("SELECT * FROM instances WHERE id = ? AND type = 'thing'").get(target_id) as Instance | null;
  if (!thing || thing.is_void || thing.is_destroyed) return { error: "thing not found or is void" };

  // Must be in agent's current node (or a container within it)
  const thingNode = getContainingNode(thing);
  if (thingNode !== agent.current_node_id) return { error: "thing is not in your current node" };

  // Check contain permission on the thing
  if (!checkPermission(agent, thing, "contain")) return { error: "no contain permission on thing" };

  // Check contain permission on the thing's current container
  if (thing.container_type === "instance" && thing.container_id) {
    const container = db.query("SELECT * FROM instances WHERE id = ?").get(thing.container_id) as Instance | null;
    if (container && !checkPermission(agent, container, "contain")) {
      return { error: "no contain permission on container" };
    }
  }

  // Fire take verb
  const denied = fireInteractions(thing, "take", agent, null);
  if (denied) return { error: "take denied by interaction" };

  // Determine destination: into agent inventory or into a thing in inventory
  if (into) {
    const dest = db.query("SELECT * FROM instances WHERE id = ? AND type = 'thing'").get(into) as Instance | null;
    if (!dest || dest.is_void || dest.is_destroyed) return { error: "destination container not found" };
    if (dest.container_type !== "agent" || dest.container_id !== agent.id) return { error: "destination must be in your inventory" };
    if (!checkPermission(agent, dest, "contain")) return { error: "no contain permission on destination" };
    if (!checkContainmentDepth(into)) return { error: "containment depth exceeded" };
    db.query("UPDATE instances SET container_type = 'instance', container_id = ? WHERE id = ?").run(into, target_id);
  } else {
    db.query("UPDATE instances SET container_type = 'agent', container_id = ? WHERE id = ?").run(agent.id, target_id);
  }

  broadcastToNode(agent.current_node_id, "broadcast", {
    message: `${agent.username} takes ${thing.short_description}.`,
  }, agent.id);

  return { taken: true, thing_id: target_id };
}

export function processDrop(agent: Agent, params: any): any {
  const { target_id, into } = params;
  if (!target_id) return { error: "target_id required" };

  const thing = db.query("SELECT * FROM instances WHERE id = ? AND type = 'thing'").get(target_id) as Instance | null;
  if (!thing || thing.is_void || thing.is_destroyed) return { error: "thing not found or is void" };

  // Must be in agent's inventory (directly or nested)
  if (!isInAgentInventory(thing, agent.id)) {
    return { error: "thing is not in your inventory" };
  }

  // Fire drop verb
  const denied = fireInteractions(thing, "drop", agent, null);
  if (denied) return { error: "drop denied by interaction" };

  // Drop into current node or into a specific container in the node
  if (into) {
    const dest = db.query("SELECT * FROM instances WHERE id = ?").get(into) as Instance | null;
    if (!dest || dest.is_void || dest.is_destroyed) return { error: "destination not found" };
    if (!checkPermission(agent, dest, "contain")) return { error: "no contain permission on destination" };
    const destNode = getContainingNode(dest);
    if (destNode !== agent.current_node_id) return { error: "destination not in current node" };
    if (!checkContainmentDepth(into)) return { error: "containment depth exceeded" };
    db.query("UPDATE instances SET container_type = 'instance', container_id = ? WHERE id = ?").run(into, target_id);
  } else {
    db.query("UPDATE instances SET container_type = 'instance', container_id = ? WHERE id = ?").run(agent.current_node_id, target_id);
  }

  broadcastToNode(agent.current_node_id, "broadcast", {
    message: `${agent.username} drops ${thing.short_description}.`,
  }, agent.id);

  return { dropped: true, thing_id: target_id };
}

function isInAgentInventory(instance: Instance, agentId: string): boolean {
  if (instance.container_type === "agent" && instance.container_id === agentId) return true;
  if (instance.container_type === "instance" && instance.container_id) {
    const parent = db.query("SELECT * FROM instances WHERE id = ?").get(instance.container_id) as Instance | null;
    if (parent) return isInAgentInventory(parent, agentId);
  }
  return false;
}

export function processCustomVerb(agent: Agent, verb: string, params: any): any {
  const { target_id, subject_id } = params;
  if (!target_id) return { error: "target_id required" };

  const target = db.query("SELECT * FROM instances WHERE id = ?").get(target_id) as Instance | null;
  if (!target || target.is_void || target.is_destroyed) return { error: "target not found or is void" };

  // Check interact permission
  if (!checkPermission(agent, target, "interact")) return { error: "no interact permission" };

  // Special: "reset" verb in home node
  if (verb === "reset" && target.id === agent.home_node_id) {
    resetHomeNode(agent.id, agent.username);
    return { reset: true };
  }

  // Resolve subject
  let subject: Instance | null = null;
  if (subject_id) {
    subject = db.query("SELECT * FROM instances WHERE id = ?").get(subject_id) as Instance | null;
    if (!subject || subject.is_void || subject.is_destroyed) return { error: "subject not found or is void" };
  }

  const denied = fireInteractions(target, verb, agent, subject);
  if (denied) return { error: "action denied by interaction" };

  return { verb_fired: true, target_id, verb };
}
