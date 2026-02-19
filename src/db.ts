import { Database } from "bun:sqlite";
import { DATABASE_PATH } from "./config.ts";

const db = new Database(DATABASE_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  token TEXT UNIQUE,
  current_node_id TEXT NOT NULL,
  short_description TEXT NOT NULL DEFAULT '',
  long_description TEXT NOT NULL DEFAULT '',
  see_broadcasts INTEGER NOT NULL DEFAULT 1,
  perception_max_agents INTEGER NOT NULL DEFAULT 10,
  perception_max_links INTEGER NOT NULL DEFAULT 10,
  perception_max_things INTEGER NOT NULL DEFAULT 10,
  home_node_id TEXT NOT NULL,
  ap INTEGER NOT NULL DEFAULT 4,
  created_at INTEGER NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES agents(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('node','link','thing')),
  short_description TEXT NOT NULL DEFAULT '',
  long_description TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  default_permissions TEXT NOT NULL DEFAULT '{"inspect":"any","interact":"any","edit":"owner","delete":"owner","contain":"owner","perms":"owner"}',
  interactions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK(type IN ('node','link','thing')),
  short_description TEXT NOT NULL DEFAULT '',
  long_description TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  permissions TEXT NOT NULL DEFAULT '{}',
  container_type TEXT CHECK(container_type IN ('agent','instance')),
  container_id TEXT,
  is_void INTEGER NOT NULL DEFAULT 0,
  is_destroyed INTEGER NOT NULL DEFAULT 0,
  system_type TEXT,
  interactions_used_this_tick INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS action_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  tick_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS link_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  destination_name TEXT NOT NULL DEFAULT '',
  used_at INTEGER NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS world_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);

db.exec("CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(token)");
db.exec("CREATE INDEX IF NOT EXISTS idx_agents_current_node ON agents(current_node_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_templates_owner ON templates(owner_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_instances_template ON instances(template_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_instances_container ON instances(container_type, container_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_action_queue_tick ON action_queue(tick_number, id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id, id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_link_usage_agent ON link_usage(agent_id, used_at DESC)");

// Initialize world state
const existing = db.query("SELECT value FROM world_state WHERE key = 'tick_number'").get();
if (!existing) {
  db.exec("INSERT INTO world_state (key, value) VALUES ('tick_number', '0')");
  db.exec(`INSERT INTO world_state (key, value) VALUES ('last_tick_at', '${Date.now()}')`);
}

export const AGENT_COLUMNS = "id, username, token, current_node_id, short_description, long_description, see_broadcasts, perception_max_agents, perception_max_links, perception_max_things, home_node_id, ap, created_at";

export default db;
