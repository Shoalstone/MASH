import db from "../db.ts";
import { MAX_CONTAINMENT_DEPTH } from "../config.ts";
import type { Agent, Instance, Template, PermissionKey, PermissionRule, Permissions } from "../types.ts";

export function getInstancePermission(instance: Instance, key: PermissionKey): PermissionRule {
  const perms: Permissions = JSON.parse(instance.permissions);
  if (perms[key] !== undefined) return perms[key]!;

  // Fall back to template default_permissions
  if (instance.template_id) {
    const template = db.query("SELECT default_permissions FROM templates WHERE id = ?").get(instance.template_id) as { default_permissions: string } | null;
    if (template) {
      const defaults: Permissions = JSON.parse(template.default_permissions);
      if (defaults[key] !== undefined) return defaults[key]!;
    }
  }

  return "owner";
}

export function getTemplateOwner(instance: Instance): string | null {
  if (!instance.template_id) return null;
  const template = db.query("SELECT owner_id FROM templates WHERE id = ?").get(instance.template_id) as { owner_id: string } | null;
  return template?.owner_id ?? null;
}

export function checkPermission(
  agent: Agent,
  instance: Instance,
  key: PermissionKey
): boolean {
  const rule = getInstancePermission(instance, key);
  return evaluateRule(rule, agent, instance);
}

export function evaluateRule(
  rule: PermissionRule,
  agent: Agent,
  instance: Instance
): boolean {
  if (rule === "any") return true;
  if (rule === "none") return false;
  if (rule === "owner") {
    const ownerId = getTemplateOwner(instance);
    return ownerId === agent.id;
  }
  if (rule === "node") {
    // Agent must be in the same node as the instance
    const nodeId = getContainingNode(instance);
    return nodeId !== null && agent.current_node_id === nodeId;
  }
  if (Array.isArray(rule) && rule[0] === "list") {
    return rule[1].includes(agent.username);
  }
  return false;
}

export function getContainingNode(instance: Instance): string | null {
  // If this IS a node, return its own ID
  if (instance.type === "node") return instance.id;
  // If contained by an instance, walk up
  if (instance.container_type === "instance" && instance.container_id) {
    const container = db.query("SELECT * FROM instances WHERE id = ?").get(instance.container_id) as Instance | null;
    if (container) return getContainingNode(container);
  }
  return null;
}

export function checkContainmentDepth(containerId: string, currentDepth: number = 0): boolean {
  if (currentDepth >= MAX_CONTAINMENT_DEPTH) return false;
  const container = db.query("SELECT * FROM instances WHERE id = ?").get(containerId) as Instance | null;
  if (!container) return true;
  if (container.container_type === "instance" && container.container_id) {
    return checkContainmentDepth(container.container_id, currentDepth + 1);
  }
  return true;
}

export function canEscalatePermission(
  ownerAgent: Agent,
  targetInstance: Instance,
  permKey: PermissionKey
): boolean {
  // Owner can only grant a permission they themselves hold on the target
  return checkPermission(ownerAgent, targetInstance, permKey);
}

export function checkHomeNodeAccess(agent: Agent, nodeId: string): boolean {
  const node = db.query("SELECT * FROM instances WHERE id = ? AND type = 'node'").get(nodeId) as Instance | null;
  if (!node) return true; // node doesn't exist, let action fail elsewhere

  const interactRule = getInstancePermission(node, "interact");

  // If the node is open, anyone can act
  if (interactRule === "any") return true;
  if (interactRule === "none") return false;

  // Check if the agent has interact permission
  if (evaluateRule(interactRule, agent, node)) return true;

  return false;
}
