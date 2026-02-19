export interface Agent {
  id: string;
  username: string;
  password_hash: string;
  token: string | null;
  current_node_id: string;
  short_description: string;
  long_description: string;
  see_broadcasts: number;
  perception_max_agents: number;
  perception_max_links: number;
  perception_max_things: number;
  home_node_id: string;
  ap: number;
  created_at: number;
}

export type InstanceType = "node" | "link" | "thing";

export interface Template {
  id: string;
  owner_id: string;
  name: string;
  type: InstanceType;
  short_description: string;
  long_description: string;
  fields: string; // JSON
  default_permissions: string; // JSON
  interactions: string; // JSON
  created_at: number;
}

export interface Instance {
  id: string;
  template_id: string | null;
  type: InstanceType;
  short_description: string;
  long_description: string;
  fields: string; // JSON
  permissions: string; // JSON
  container_type: "agent" | "instance" | null;
  container_id: string | null;
  is_void: number;
  is_destroyed: number;
  system_type: string | null;
  interactions_used_this_tick: number;
  created_at: number;
}

export interface ActionQueueEntry {
  id: number;
  agent_id: string;
  action: string;
  params: string; // JSON
  tick_number: number;
  created_at: number;
}

export interface Event {
  id: number;
  agent_id: string;
  type: string;
  data: string; // JSON
  created_at: number;
}

export interface LinkUsage {
  id: number;
  agent_id: string;
  link_id: string;
  destination_id: string;
  destination_name: string;
  used_at: number;
}

export type PermissionRule =
  | "any"
  | "owner"
  | "none"
  | "node"
  | ["list", string[]];

export type PermissionKey =
  | "inspect"
  | "edit"
  | "delete"
  | "interact"
  | "contain"
  | "perms";

export type Permissions = Partial<Record<PermissionKey, PermissionRule>>;

export type Condition =
  | ["eq", string, any]
  | ["neq", string, any]
  | ["gt", string, any]
  | ["lt", string, any]
  | ["has", string, string]
  | ["not", Condition];

export type Effect =
  | ["set", string, any]
  | ["add", string, number]
  | ["say", string]
  | ["take", string, string]
  | ["give", string, string]
  | ["move", string, string]
  | ["create", string, string]
  | ["destroy", string]
  | ["perm", string, string, any]
  | ["deny"];

export interface ConditionalBlock {
  if?: Condition[];
  do: EffectEntry[];
  else?: EffectEntry[];
}

export type EffectEntry = Effect | ConditionalBlock;

export interface Interaction {
  on: string;
  if?: Condition[];
  do: EffectEntry[];
  else?: EffectEntry[];
}

export interface InfoEnvelope {
  tick: number;
  next_tick_in_ms: number;
  ap: number;
  events: Array<{
    type: string;
    data: any;
    created_at: number;
  }>;
}

export interface ApiResponse<T = any> {
  info: InfoEnvelope;
  result: T;
}
