import { drizzle } from "drizzle-orm/d1";
import { usageEvent } from "./db/schema";
import type { Bindings } from "./types";

export type UsageService = "turn" | "r2" | "sfu";

const usageServices: UsageService[] = ["turn", "sfu", "r2"];

const defaultByteActions: Record<UsageService, string> = {
  turn: "turn.relay.bytes",
  sfu: "sfu.forwarded.bytes",
  r2: "r2.upload.bytes",
};

type UsagePeriod = {
  start: string;
  end: string;
  timezone: "UTC";
};

type UsageSummaryItem = {
  service: UsageService;
  bytes: number;
  quotaBytes: number | null;
};

export type UsageSummaryResponse = {
  period: UsagePeriod;
  summary: UsageSummaryItem[];
  totalBytes: number;
  totalQuotaBytes: number | null;
};

function assertByteCount(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError("bytes must be a non-negative safe integer");
  }
}

function toEpochSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

export function getCurrentMonthlyUsagePeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

  return {
    start,
    end: now,
    timezone: "UTC" as const,
  };
}

export async function recordUsage(
  env: Bindings,
  event: {
    userId: string;
    service: UsageService;
    bytes: number;
    action?: string;
    metadata?: Record<string, unknown>;
    createdAt?: Date;
  },
) {
  assertByteCount(event.bytes);

  const db = drizzle(env.DB);

  await db.insert(usageEvent).values({
    id: crypto.randomUUID(),
    userId: event.userId,
    service: event.service,
    action: event.action ?? defaultByteActions[event.service],
    bytes: event.bytes,
    metadata: { ...event.metadata, unit: "bytes" },
    createdAt: event.createdAt ?? new Date(),
  });
}

export async function getUsageSummary(
  env: Bindings,
  userId: string,
  now = new Date(),
): Promise<UsageSummaryResponse> {
  const period = getCurrentMonthlyUsagePeriod(now);
  const startSeconds = toEpochSeconds(period.start);
  const endSeconds = toEpochSeconds(period.end);
  const result = await env.DB.prepare(
    `SELECT service, SUM(CASE WHEN bytes > 0 THEN bytes ELSE 0 END) AS bytes
     FROM usage_event
     WHERE user_id = ?
       AND created_at >= ?
       AND created_at <= ?
       AND service IN ('turn', 'sfu', 'r2')
     GROUP BY service`,
  )
    .bind(userId, startSeconds, endSeconds)
    .all<{
      service: UsageService;
      bytes: number | null;
    }>();

  const bytesByService = new Map<UsageService, number>();
  for (const row of result.results) {
    if (usageServices.includes(row.service)) {
      bytesByService.set(row.service, row.bytes ?? 0);
    }
  }

  const summary = usageServices.map((service) => ({
    service,
    bytes: bytesByService.get(service) ?? 0,
    quotaBytes: null,
  }));
  const totalBytes = summary.reduce((total, item) => total + item.bytes, 0);

  return {
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      timezone: period.timezone,
    },
    summary,
    totalBytes,
    totalQuotaBytes: null,
  };
}
