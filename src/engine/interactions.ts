import { nanoid } from "nanoid";
import db, { AGENT_COLUMNS } from "../db.ts";
import { MAX_INTERACTIONS_PER_TICK } from "../config.ts";
import type { Agent, Instance, Template, Interaction, Condition, Effect, EffectEntry, ConditionalBlock, Permissions, PermissionKey } from "../types.ts";
import { checkPermission } from "./permissions.ts";
import { broadcastToNode, addEvent } from "../response.ts";
import { getContainingNode } from "./permissions.ts";

/**
 * Fire all matching interactions on an instance for a given verb.
 * Returns true if any interaction issued a "deny".
 */
export function fireInteractions(
  instance: Instance,
  verb: string,
  actor: Agent | null,
  subject: Instance | null,
): boolean {
  if (instance.is_void || instance.is_destroyed) return false;
  if (!instance.template_id) return false;

  const template = db.query("SELECT * FROM templates WHERE id = ?").get(instance.template_id) as Template | null;
  if (!template) return false;

  const interactions: Interaction[] = JSON.parse(template.interactions);
  const matching = interactions.filter((i) => i.on === verb);
  if (matching.length === 0) return false;

  // Refresh instance to get current interactions_used_this_tick
  const fresh = db.query("SELECT interactions_used_this_tick FROM instances WHERE id = ?").get(instance.id) as { interactions_used_this_tick: number } | null;
  let usedThisTick = fresh?.interactions_used_this_tick ?? 0;

  const ctx: InteractionContext = {
    self: instance,
    actor,
    subject,
    template,
    denied: false,
  };

  for (const interaction of matching) {
    if (usedThisTick >= MAX_INTERACTIONS_PER_TICK) break;
    if (ctx.denied) break;

    const conditionsMet = interaction.if ? evaluateConditions(interaction.if, ctx) : true;

    if (conditionsMet) {
      executeEffects(interaction.do, ctx);
    } else if (interaction.else) {
      executeEffects(interaction.else, ctx);
    }

    usedThisTick++;
    db.query("UPDATE instances SET interactions_used_this_tick = ? WHERE id = ?").run(usedThisTick, instance.id);
  }

  return ctx.denied;
}

interface InteractionContext {
  self: Instance;
  actor: Agent | null;
  subject: Instance | null;
  template: Template;
  denied: boolean;
}

// --- Reference Resolution ---

function resolveRef(ref: string, ctx: InteractionContext): any {
  const parts = ref.split(".");
  const root = parts[0]!;

  if (root === "self") return resolveSelfRef(parts.slice(1), ctx);
  if (root === "actor") return resolveActorRef(parts.slice(1), ctx);
  if (root === "subject") return resolveSubjectRef(parts.slice(1), ctx);
  if (root === "carrier") return resolveCarrierRef(parts.slice(1), ctx);
  if (root === "container") return resolveContainerRef(parts.slice(1), ctx);
  if (root === "tick") return resolveTickRef(parts.slice(1));

  return undefined;
}

function resolveSelfRef(parts: string[], ctx: InteractionContext): any {
  if (parts.length === 0) return ctx.self.id;

  // Refresh self from DB to get latest state
  const fresh = db.query("SELECT * FROM instances WHERE id = ?").get(ctx.self.id) as Instance | null;
  if (!fresh) return undefined;
  ctx.self = fresh;

  const field = parts[0]!;

  if (field === "short_description") return ctx.self.short_description;
  if (field === "long_description") return ctx.self.long_description;
  if (field === "id") return ctx.self.id;
  if (field === "type") return ctx.self.type;

  // self.contents.t:TEMPLATE_ID.fieldname
  if (field === "contents" && parts.length >= 3) {
    const templateSpec = parts[1]!;
    if (templateSpec.startsWith("t:")) {
      const tplId = templateSpec.slice(2);
      const contained = db.query(
        "SELECT * FROM instances WHERE container_type = 'instance' AND container_id = ? AND template_id = ? AND is_void = 0 AND is_destroyed = 0 LIMIT 1"
      ).get(ctx.self.id, tplId) as Instance | null;
      if (!contained) return undefined;
      const subField = parts[2]!;
      const fields = JSON.parse(contained.fields);
      return fields[subField];
    }
  }

  // Regular field lookup
  const fields = JSON.parse(ctx.self.fields);
  return fields[field];
}

function resolveActorRef(parts: string[], ctx: InteractionContext): any {
  if (!ctx.actor) return undefined;
  if (parts.length === 0) return ctx.actor.id;
  const field = parts[0]!;
  if (field === "username") return ctx.actor.username;
  if (field === "id") return ctx.actor.id;
  if (field === "short_description") return ctx.actor.short_description;
  if (field === "long_description") return ctx.actor.long_description;
  return undefined;
}

function getCarrierAgent(instance: Instance): Agent | null {
  if (instance.container_type === "agent" && instance.container_id) {
    return db.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`).get(instance.container_id) as Agent | null;
  }
  if (instance.container_type === "instance" && instance.container_id) {
    const parent = db.query("SELECT * FROM instances WHERE id = ?").get(instance.container_id) as Instance | null;
    if (parent) return getCarrierAgent(parent);
  }
  return null;
}

function resolveCarrierRef(parts: string[], ctx: InteractionContext): any {
  const carrier = getCarrierAgent(ctx.self);
  if (!carrier) return undefined;
  if (parts.length === 0) return carrier.id;

  const field = parts[0]!;
  if (field === "id") return carrier.id;
  if (field === "username") return carrier.username;
  if (field === "short_description") return carrier.short_description;
  if (field === "long_description") return carrier.long_description;

  // carrier.contents.t:TEMPLATE_ID.fieldname
  if (field === "contents" && parts.length >= 3) {
    const templateSpec = parts[1]!;
    if (templateSpec.startsWith("t:")) {
      const tplId = templateSpec.slice(2);
      const contained = db.query(
        "SELECT * FROM instances WHERE container_type = 'agent' AND container_id = ? AND template_id = ? AND is_void = 0 AND is_destroyed = 0 LIMIT 1"
      ).get(carrier.id, tplId) as Instance | null;
      if (!contained) return undefined;
      const subField = parts[2]!;
      const fields = JSON.parse(contained.fields);
      return fields[subField];
    }
  }

  return undefined;
}

function resolveSubjectRef(parts: string[], ctx: InteractionContext): any {
  if (!ctx.subject) return undefined;
  if (parts.length === 0) return ctx.subject.id;

  // Refresh from DB
  const fresh = db.query("SELECT * FROM instances WHERE id = ?").get(ctx.subject.id) as Instance | null;
  if (!fresh) return undefined;
  ctx.subject = fresh;

  const field = parts[0]!;
  if (field === "short_description") return ctx.subject.short_description;
  if (field === "long_description") return ctx.subject.long_description;
  if (field === "id") return ctx.subject.id;

  const fields = JSON.parse(ctx.subject.fields);
  return fields[field];
}

function resolveContainerRef(parts: string[], ctx: InteractionContext): any {
  if (ctx.self.container_type !== "instance" || !ctx.self.container_id) return undefined;

  const container = db.query("SELECT * FROM instances WHERE id = ?").get(ctx.self.container_id) as Instance | null;
  if (!container) return undefined;

  if (parts.length === 0) return container.id;

  const field = parts[0]!;
  if (field === "short_description") return container.short_description;
  if (field === "long_description") return container.long_description;
  if (field === "id") return container.id;

  const fields = JSON.parse(container.fields);
  return fields[field];
}

function resolveTickRef(parts: string[]): any {
  if (parts.length === 0) return undefined;
  if (parts[0] === "count") {
    const now = new Date();
    return now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  }
  return undefined;
}

// --- Condition Evaluation ---

function evaluateConditions(conditions: Condition[], ctx: InteractionContext): boolean {
  return conditions.every((c) => evaluateCondition(c, ctx));
}

function evaluateCondition(condition: Condition, ctx: InteractionContext): boolean {
  const [op] = condition;

  if (op === "not") {
    return !evaluateCondition(condition[1], ctx);
  }
  if (op === "eq") {
    const val = resolveRef(condition[1], ctx);
    return val === condition[2];
  }
  if (op === "neq") {
    const val = resolveRef(condition[1], ctx);
    return val !== condition[2];
  }
  if (op === "gt") {
    const val = resolveRef(condition[1], ctx);
    return typeof val === "number" && val > condition[2];
  }
  if (op === "lt") {
    const val = resolveRef(condition[1], ctx);
    return typeof val === "number" && val < condition[2];
  }
  if (op === "has") {
    // Check if ref (an instance or agent) contains an instance of template_id
    const containerId = resolveRef(condition[1], ctx);
    if (!containerId) return false;
    const templateId = condition[2];
    const found = db.query(
      "SELECT id FROM instances WHERE container_id = ? AND template_id = ? AND is_void = 0 AND is_destroyed = 0 LIMIT 1"
    ).get(containerId, templateId);
    return !!found;
  }

  return false;
}

// --- Effect Execution ---

function isConditionalBlock(entry: EffectEntry): entry is ConditionalBlock {
  return !Array.isArray(entry) && typeof entry === "object" && entry !== null && "do" in entry;
}

function executeEffects(effects: EffectEntry[], ctx: InteractionContext): void {
  for (const entry of effects) {
    if (ctx.denied) break;
    if (isConditionalBlock(entry)) {
      const conditionsMet = entry.if ? evaluateConditions(entry.if, ctx) : true;
      if (conditionsMet) {
        executeEffects(entry.do, ctx);
      } else if (entry.else) {
        executeEffects(entry.else, ctx);
      }
    } else {
      executeEffect(entry, ctx);
    }
  }
}

function executeEffect(effect: Effect, ctx: InteractionContext): void {
  const [op] = effect;

  if (op === "deny") {
    ctx.denied = true;
    return;
  }

  if (op === "set") {
    const [, ref, value] = effect;
    setRef(ref, value, ctx);
    return;
  }

  if (op === "add") {
    const [, ref, rawAmount] = effect;
    const amount = typeof rawAmount === "string" ? resolveRef(rawAmount, ctx) : rawAmount;
    if (typeof amount !== "number") return;
    const current = resolveRef(ref, ctx);
    const newVal = (typeof current === "number" ? current : 0) + amount;
    setRef(ref, newVal, ctx);
    return;
  }

  if (op === "say") {
    const [, messageTemplate] = effect;
    const message = interpolate(messageTemplate, ctx);
    const nodeId = getContainingNode(ctx.self);
    if (nodeId) {
      broadcastToNode(nodeId, "broadcast", { message });
    }
    return;
  }

  if (op === "take") {
    // take template_id from ref into self
    const [, templateId, fromRef] = effect;
    const fromId = resolveRef(fromRef, ctx);
    if (!fromId) return;

    // Determine if the source is an agent or an instance
    const fromIsAgent = isAgentId(fromId, ctx);
    if (!fromIsAgent && !checkEffectPermission(ctx, fromId, "contain")) return;

    const containerType = fromIsAgent ? "agent" : "instance";
    const thing = db.query(
      "SELECT * FROM instances WHERE template_id = ? AND container_type = ? AND container_id = ? AND is_void = 0 AND is_destroyed = 0 LIMIT 1"
    ).get(templateId, containerType, fromId) as Instance | null;
    if (!thing) return;

    db.query("UPDATE instances SET container_type = 'instance', container_id = ? WHERE id = ?").run(ctx.self.id, thing.id);
    return;
  }

  if (op === "give") {
    // give template_id from self to ref
    const [, templateId, toRef] = effect;
    const toId = resolveRef(toRef, ctx);
    if (!toId) return;

    // Determine if the destination is an agent or an instance
    const toIsAgent = isAgentId(toId, ctx);
    if (!toIsAgent && !checkEffectPermission(ctx, toId, "contain")) return;

    const thing = db.query(
      "SELECT * FROM instances WHERE template_id = ? AND container_type = 'instance' AND container_id = ? AND is_void = 0 AND is_destroyed = 0 LIMIT 1"
    ).get(templateId, ctx.self.id) as Instance | null;
    if (!thing) return;

    const containerType = toIsAgent ? "agent" : "instance";
    db.query("UPDATE instances SET container_type = ?, container_id = ? WHERE id = ?").run(containerType, toId, thing.id);
    return;
  }

  if (op === "move") {
    // move ref to node_id (or ref that resolves to a node_id)
    const [, ref, destRef] = effect;
    const targetId = resolveRef(ref, ctx);
    if (!targetId) return;
    const nodeId = resolveRef(destRef, ctx) ?? destRef;

    // If moving self or an agent, always allowed; otherwise check permission
    const moveIsAgent = isAgentId(targetId, ctx);
    if (targetId !== ctx.self.id && !moveIsAgent && !checkEffectPermission(ctx, targetId, "contain")) return;

    // Check if target is an agent
    const agent = db.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`).get(targetId) as Agent | null;
    if (agent) {
      const destNode = db.query("SELECT * FROM instances WHERE id = ? AND type = 'node' AND is_void = 0 AND is_destroyed = 0").get(nodeId) as Instance | null;
      if (destNode) {
        db.query("UPDATE agents SET current_node_id = ? WHERE id = ?").run(nodeId, targetId);
        addEvent(targetId, "system", { message: `You have been moved to ${destNode.short_description}.` });
      }
      return;
    }

    // Otherwise it's an instance — move its container
    const instance = db.query("SELECT * FROM instances WHERE id = ?").get(targetId) as Instance | null;
    if (instance) {
      db.query("UPDATE instances SET container_type = 'instance', container_id = ? WHERE id = ?").run(nodeId, targetId);
    }
    return;
  }

  if (op === "create") {
    // create instance of template_id at ref
    const [, templateId, atRef] = effect;
    const containerId = resolveRef(atRef, ctx);
    if (!containerId) return;

    const template = db.query("SELECT * FROM templates WHERE id = ?").get(templateId) as Template | null;
    if (!template) return;

    // Determine if the target container is an agent or an instance
    const createIsAgent = isAgentId(containerId, ctx);
    const containerType = createIsAgent ? "agent" : "instance";

    const id = nanoid();
    db.query(`
      INSERT INTO instances (id, template_id, type, short_description, long_description, fields, permissions, container_type, container_id, is_void, is_destroyed, system_type, interactions_used_this_tick, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, 0, 0, NULL, 0, ?)
    `).run(id, template.id, template.type, template.short_description, template.long_description, template.fields, containerType, containerId, Date.now());
    return;
  }

  if (op === "destroy") {
    const [, ref] = effect;
    const targetId = resolveRef(ref, ctx);
    if (!targetId) return;

    if (targetId !== ctx.self.id && !checkEffectPermission(ctx, targetId, "delete")) return;

    db.query("UPDATE instances SET is_destroyed = 1 WHERE id = ?").run(targetId);
    return;
  }

  if (op === "perm") {
    // perm ref permKey value
    const [, ref, permKey, value] = effect;
    const targetId = resolveRef(ref, ctx);
    if (!targetId) return;

    const target = db.query("SELECT * FROM instances WHERE id = ?").get(targetId) as Instance | null;
    if (!target) return;

    // Check escalation: template owner must hold the permission being granted
    if (targetId !== ctx.self.id) {
      if (!checkEffectPermission(ctx, targetId, "perms")) return;

      // Escalation check: owner must have the permission they're granting
      const owner = db.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`).get(ctx.template.owner_id) as Agent | null;
      if (owner && !checkPermission(owner, target, permKey as PermissionKey)) return;
    }

    const perms: Permissions = JSON.parse(target.permissions);
    (perms as any)[permKey] = value;
    db.query("UPDATE instances SET permissions = ? WHERE id = ?").run(JSON.stringify(perms), targetId);
    return;
  }
}

function setRef(ref: string, value: any, ctx: InteractionContext): void {
  const parts = ref.split(".");
  const root = parts[0]!;

  if (root === "self") {
    if (parts.length < 2) return;
    const field = parts[1]!;
    if (field === "short_description") {
      db.query("UPDATE instances SET short_description = ? WHERE id = ?").run(String(value), ctx.self.id);
      ctx.self.short_description = String(value);
      return;
    }
    if (field === "long_description") {
      db.query("UPDATE instances SET long_description = ? WHERE id = ?").run(String(value), ctx.self.id);
      ctx.self.long_description = String(value);
      return;
    }
    // Set a field value
    const fields = JSON.parse(ctx.self.fields);
    fields[field] = value;
    const newFields = JSON.stringify(fields);
    db.query("UPDATE instances SET fields = ? WHERE id = ?").run(newFields, ctx.self.id);
    ctx.self.fields = newFields;
    return;
  }

  if (root === "subject" && ctx.subject) {
    if (parts.length < 2) return;
    if (!checkEffectPermission(ctx, ctx.subject.id, "edit")) return;
    const field = parts[1]!;
    if (field === "short_description") {
      db.query("UPDATE instances SET short_description = ? WHERE id = ?").run(String(value), ctx.subject.id);
      return;
    }
    if (field === "long_description") {
      db.query("UPDATE instances SET long_description = ? WHERE id = ?").run(String(value), ctx.subject.id);
      return;
    }
    const fresh = db.query("SELECT fields FROM instances WHERE id = ?").get(ctx.subject.id) as { fields: string } | null;
    if (!fresh) return;
    const fields = JSON.parse(fresh.fields);
    fields[field] = value;
    db.query("UPDATE instances SET fields = ? WHERE id = ?").run(JSON.stringify(fields), ctx.subject.id);
    return;
  }

  if (root === "container") {
    if (parts.length < 2) return;
    if (!ctx.self.container_id) return;
    if (!checkEffectPermission(ctx, ctx.self.container_id, "edit")) return;
    const field = parts[1]!;
    const container = db.query("SELECT fields FROM instances WHERE id = ?").get(ctx.self.container_id) as { fields: string } | null;
    if (!container) return;
    if (field === "short_description") {
      db.query("UPDATE instances SET short_description = ? WHERE id = ?").run(String(value), ctx.self.container_id);
      return;
    }
    if (field === "long_description") {
      db.query("UPDATE instances SET long_description = ? WHERE id = ?").run(String(value), ctx.self.container_id);
      return;
    }
    const fields = JSON.parse(container.fields);
    fields[field] = value;
    db.query("UPDATE instances SET fields = ? WHERE id = ?").run(JSON.stringify(fields), ctx.self.container_id);
    return;
  }
}

function isAgentId(id: string, ctx: InteractionContext): boolean {
  if (ctx.actor && id === ctx.actor.id) return true;
  return !!db.query("SELECT id FROM agents WHERE id = ?").get(id);
}

function checkEffectPermission(ctx: InteractionContext, targetId: string, permKey: PermissionKey): boolean {
  // Effects on self always succeed
  if (targetId === ctx.self.id) return true;

  // Otherwise use template owner's permissions
  const owner = db.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`).get(ctx.template.owner_id) as Agent | null;
  if (!owner) return false;

  const target = db.query("SELECT * FROM instances WHERE id = ?").get(targetId) as Instance | null;
  if (!target) return false;

  return checkPermission(owner, target, permKey);
}

function interpolate(template: string, ctx: InteractionContext): string {
  return template.replace(/\{([^}]+)\}/g, (_, ref) => {
    const val = resolveRef(ref, ctx);
    return val !== undefined ? String(val) : `{${ref}}`;
  });
}
