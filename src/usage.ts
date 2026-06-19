import { drizzle } from "drizzle-orm/d1";
import { usageEvent } from "./db/schema";
import type { Bindings } from "./types";

export type UsageService = "turn" | "r2" | "sfu";

export async function recordUsage(
  env: Bindings,
  event: {
    userId: string;
    service: UsageService;
    action: string;
    quantity?: number;
    metadata?: Record<string, unknown>;
  },
) {
  const db = drizzle(env.DB);

  await db.insert(usageEvent).values({
    id: crypto.randomUUID(),
    userId: event.userId,
    service: event.service,
    action: event.action,
    quantity: event.quantity ?? 1,
    metadata: event.metadata,
    createdAt: new Date(),
  });
}

export async function getUsageSummary(env: Bindings, userId: string) {
  const result = await env.DB.prepare(
    `SELECT service, action, COUNT(*) AS events, SUM(quantity) AS quantity
     FROM usage_event
     WHERE user_id = ?
     GROUP BY service, action
     ORDER BY service, action`,
  )
    .bind(userId)
    .all<{
      service: UsageService;
      action: string;
      events: number;
      quantity: number;
    }>();

  return result.results;
}
