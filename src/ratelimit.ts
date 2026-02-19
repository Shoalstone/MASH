import type { Context, Next } from "hono";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

const attempts = new Map<string, number[]>();

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of attempts) {
    const valid = timestamps.filter((t) => now - t < WINDOW_MS);
    if (valid.length === 0) {
      attempts.delete(ip);
    } else {
      attempts.set(ip, valid);
    }
  }
}, CLEANUP_INTERVAL_MS);

export function rateLimit() {
  return async (c: Context, next: Next) => {
    const ip = c.req.header("X-Real-IP") || "unknown";
    const now = Date.now();

    const timestamps = attempts.get(ip) || [];
    const recent = timestamps.filter((t) => now - t < WINDOW_MS);

    if (recent.length >= MAX_ATTEMPTS) {
      return c.json({ error: "too many requests, try again later" }, 429);
    }

    recent.push(now);
    attempts.set(ip, recent);

    await next();
  };
}
