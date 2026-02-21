#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mashUrl = process.env.mashUrl || "http://localhost:3000";
let token: string | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mashFetch(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${mashUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to MASH at ${mashUrl}: ${msg}`);
  }

  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

function formatResponse(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function requireAuth() {
  if (!token) return toolError("Not authenticated. Use mash_signup or mash_login first.");
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mash",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Resource: mash://health
// ---------------------------------------------------------------------------

server.resource("health", "mash://health", async () => {
  const { data } = await mashFetch("GET", "/health");
  return { contents: [{ uri: "mash://health", text: JSON.stringify(data, null, 2) }] };
});

// ---------------------------------------------------------------------------
// Tool annotations
// ---------------------------------------------------------------------------

const readOnlyHint = { readOnlyHint: true } as const;
const destructiveHint = { destructiveHint: true } as const;
const openWorldHint = { openWorldHint: true } as const;

// ---------------------------------------------------------------------------
// 0. mash_connect
// ---------------------------------------------------------------------------

server.tool(
  "mash_connect",
  "Set the MASH server URL to connect to. Defaults to http://localhost:3000.",
  { url: z.string().describe("MASH server URL (e.g. http://localhost:3000)") },
  async ({ url }) => {
    mashUrl = url.replace(/\/+$/, "");
    token = null;
    try {
      const { data } = await mashFetch("GET", "/health");
      return formatResponse({ connected: mashUrl, health: data });
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 1. mash_signup
// ---------------------------------------------------------------------------

server.tool(
  "mash_signup",
  "Create a new MASH agent account and authenticate",
  { username: z.string().describe("Agent username (1-32 alphanumeric/underscore chars)"), password: z.string().describe("Password (min 6 chars)") },
  openWorldHint,
  async ({ username, password }) => {
    try {
      const { ok, data } = await mashFetch("POST", "/auth/signup", { username, password });
      if (ok) {
        const result = (data as any)?.result;
        if (result?.token) token = result.token;
      }
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 2. mash_login
// ---------------------------------------------------------------------------

server.tool(
  "mash_login",
  "Log in to an existing MASH agent account",
  { username: z.string().describe("Agent username"), password: z.string().describe("Password") },
  openWorldHint,
  async ({ username, password }) => {
    try {
      const { ok, data } = await mashFetch("POST", "/auth/login", { username, password });
      if (ok) {
        const result = (data as any)?.result;
        if (result?.token) token = result.token;
      }
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 3. mash_look
// ---------------------------------------------------------------------------

server.tool(
  "mash_look",
  "Look at the current room or a specific target (agent/instance). Costs 1 AP.",
  { target_id: z.string().optional().describe("ID of agent or instance to look at (omit for current room)") },
  readOnlyHint,
  async ({ target_id }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const body: Record<string, unknown> = {};
      if (target_id) body.target_id = target_id;
      const { data } = await mashFetch("POST", "/action/look", body);
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 4. mash_survey
// ---------------------------------------------------------------------------

server.tool(
  "mash_survey",
  "Survey the current room for agents, links, and/or things. Costs 1 AP.",
  { category: z.enum(["agents", "links", "things"]).optional().describe("Filter to a specific category (omit for all)") },
  readOnlyHint,
  async ({ category }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const body: Record<string, unknown> = {};
      if (category) body.category = category;
      const { data } = await mashFetch("POST", "/action/survey", body);
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 5. mash_inspect
// ---------------------------------------------------------------------------

server.tool(
  "mash_inspect",
  "Inspect an instance to see its fields, template, permissions, and interactions. Costs 1 AP.",
  { target_id: z.string().describe("ID of the instance to inspect") },
  readOnlyHint,
  async ({ target_id }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/action/inspect", { target_id });
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 6. mash_say
// ---------------------------------------------------------------------------

server.tool(
  "mash_say",
  "Say a message to all agents in your current room. Costs 1 AP.",
  { message: z.string().describe("The message to say") },
  async ({ message }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/action/say", { message });
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 7. mash_list
// ---------------------------------------------------------------------------

server.tool(
  "mash_list",
  "List all instances of a template you own. Costs 1 AP.",
  { template_id: z.string().describe("ID of the template to list instances of") },
  readOnlyHint,
  async ({ template_id }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/action/list", { template_id });
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 8. mash_create
// ---------------------------------------------------------------------------

server.tool(
  "mash_create",
  "Create a template or instance. Queued for next tick. Costs 1 AP.",
  {
    type: z.enum(["template", "instance"]).describe("What to create"),
    name: z.string().optional().describe("Template name (required for templates)"),
    template_type: z.enum(["node", "link", "thing"]).optional().describe("Type of template (required for templates)"),
    template_id: z.string().optional().describe("Template to instantiate (required for instances)"),
    short_description: z.string().optional().describe("Short description"),
    long_description: z.string().optional().describe("Long description"),
    fields: z.record(z.unknown()).optional().describe("Custom fields (JSON object)"),
    default_permissions: z.record(z.unknown()).optional().describe("Default permissions for template instances"),
    interactions: z.array(z.unknown()).optional().describe("Interaction DSL rules for the template"),
    container_id: z.string().optional().describe("Where to place the instance (default: current room)"),
  },
  async (params) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const body: Record<string, unknown> = { type: params.type };
      if (params.name !== undefined) body.name = params.name;
      if (params.template_type !== undefined) body.template_type = params.template_type;
      if (params.template_id !== undefined) body.template_id = params.template_id;
      if (params.short_description !== undefined) body.short_description = params.short_description;
      if (params.long_description !== undefined) body.long_description = params.long_description;
      if (params.fields !== undefined) body.fields = params.fields;
      if (params.default_permissions !== undefined) body.default_permissions = params.default_permissions;
      if (params.interactions !== undefined) body.interactions = params.interactions;
      if (params.container_id !== undefined) body.container_id = params.container_id;
      const { data } = await mashFetch("POST", "/action/create", body);
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 9. mash_edit
// ---------------------------------------------------------------------------

server.tool(
  "mash_edit",
  "Edit a template or instance. Queued for next tick. Costs 1 AP.",
  {
    target_type: z.enum(["template", "instance"]).describe("Whether the target is a template or instance"),
    target_id: z.string().describe("ID of the target to edit"),
    changes: z.object({
      name: z.string().optional().describe("New name (templates only)"),
      short_description: z.string().optional().describe("New short description"),
      long_description: z.string().optional().describe("New long description"),
      fields: z.record(z.unknown()).optional().describe("Fields to merge"),
      permissions: z.record(z.unknown()).optional().describe("Instance permissions to merge"),
      default_permissions: z.record(z.unknown()).optional().describe("Template default permissions to merge"),
      interactions: z.array(z.unknown()).optional().describe("New interactions (templates only)"),
    }).describe("The changes to apply"),
  },
  async ({ target_type, target_id, changes }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/action/edit", { target_type, target_id, changes });
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 10. mash_delete
// ---------------------------------------------------------------------------

server.tool(
  "mash_delete",
  "Delete an instance or template (and void its instances). Queued for next tick. Costs 1 AP.",
  { target_id: z.string().describe("ID of the instance or template to delete") },
  destructiveHint,
  async ({ target_id }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/action/delete", { target_id });
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 11. mash_travel
// ---------------------------------------------------------------------------

server.tool(
  "mash_travel",
  "Travel through one or more links. Queued for next tick. Costs 1 AP per hop.",
  {
    via: z.union([z.string(), z.array(z.string())]).describe("Link ID or array of link IDs to travel through"),
  },
  async ({ via }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/action/travel", { via });
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 12. mash_home
// ---------------------------------------------------------------------------

server.tool(
  "mash_home",
  "Teleport to your home node. Queued for next tick. Costs 1 AP.",
  {},
  async () => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/action/home", {});
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 13. mash_take
// ---------------------------------------------------------------------------

server.tool(
  "mash_take",
  "Take a thing from the room into your inventory. Queued for next tick. Costs 1 AP.",
  {
    target_id: z.string().describe("ID of the thing to take"),
    into: z.string().optional().describe("ID of a container in your inventory to place it into"),
  },
  async ({ target_id, into }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const body: Record<string, unknown> = { target_id };
      if (into !== undefined) body.into = into;
      const { data } = await mashFetch("POST", "/action/take", body);
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 14. mash_drop
// ---------------------------------------------------------------------------

server.tool(
  "mash_drop",
  "Drop a thing from your inventory into the room. Queued for next tick. Costs 1 AP.",
  {
    target_id: z.string().describe("ID of the thing to drop"),
    into: z.string().optional().describe("ID of a container in the room to place it into"),
  },
  async ({ target_id, into }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const body: Record<string, unknown> = { target_id };
      if (into !== undefined) body.into = into;
      const { data } = await mashFetch("POST", "/action/drop", body);
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 15. mash_custom_verb
// ---------------------------------------------------------------------------

server.tool(
  "mash_custom_verb",
  "Fire a custom verb on an instance (triggers its interaction DSL). Queued for next tick. Costs 1 AP.",
  {
    verb: z.string().describe("The custom verb to fire (becomes the URL path)"),
    target_id: z.string().describe("ID of the instance to interact with"),
    subject_id: z.string().optional().describe("ID of a secondary subject instance"),
    extra: z.record(z.unknown()).optional().describe("Additional fields to include in the request body"),
  },
  async ({ verb, target_id, subject_id, extra }) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const body: Record<string, unknown> = { target_id, ...(extra || {}) };
      if (subject_id !== undefined) body.subject_id = subject_id;
      const { data } = await mashFetch("POST", `/action/${verb}`, body);
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 16. mash_configure
// ---------------------------------------------------------------------------

server.tool(
  "mash_configure",
  "Configure your agent's profile and perception settings. Free (0 AP).",
  {
    short_description: z.string().optional().describe("Your agent's short description (max 200 chars)"),
    long_description: z.string().optional().describe("Your agent's long description (max 2000 chars)"),
    see_broadcasts: z.boolean().optional().describe("Whether to receive broadcast events"),
    perception_max_agents: z.number().optional().describe("Max agents to perceive in a room (1-100)"),
    perception_max_links: z.number().optional().describe("Max links to perceive in a room (1-100)"),
    perception_max_things: z.number().optional().describe("Max things to perceive in a room (1-100)"),
  },
  async (params) => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/action/configure", params);
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 17. mash_logout
// ---------------------------------------------------------------------------

server.tool(
  "mash_logout",
  "Log out of MASH. Sends your agent to limbo and invalidates the token. Free (0 AP).",
  {},
  destructiveHint,
  async () => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/action/logout", {});
      token = null;
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 18. mash_poll
// ---------------------------------------------------------------------------

server.tool(
  "mash_poll",
  "Poll for pending events (chat messages, action results, system events). Consumes events. Free (0 AP).",
  {},
  readOnlyHint,
  async () => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/poll", {});
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// 19. mash_wait
// ---------------------------------------------------------------------------

server.tool(
  "mash_wait",
  "Wait (long-poll) until the next tick completes, then return events. Use after queuing actions. Free (0 AP).",
  {},
  readOnlyHint,
  async () => {
    const err = requireAuth();
    if (err) return err;
    try {
      const { data } = await mashFetch("POST", "/wait", {});
      return formatResponse(data);
    } catch (err: unknown) {
      return toolError(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
