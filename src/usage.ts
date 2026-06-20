import type { Bindings } from "./types";

export const usageServices = ["direct", "stun", "turn", "sfu", "r2", "durable"] as const;
export type UsageService = (typeof usageServices)[number];
export type UsageUnit = "bytes" | "requests";

export const serviceUnits: Record<UsageService, UsageUnit> = {
  direct: "bytes",
  stun: "bytes",
  turn: "bytes",
  sfu: "bytes",
  r2: "bytes",
  durable: "requests",
};

const defaultActions: Record<UsageService, string> = {
  direct: "direct.transfer.bytes",
  stun: "stun.transfer.bytes",
  turn: "turn.relay.bytes",
  sfu: "sfu.forwarded.bytes",
  r2: "r2.upload.bytes",
  durable: "durable.request",
};

type UsagePeriod = {
  start: string;
  end: string;
  timezone: "UTC";
};

export type UsageSummaryItem = {
  service: UsageService;
  unit: UsageUnit;
  usage: number;
  quota: number | null;
  bytes: number;
  quotaBytes: number | null;
};

export type UsageSummaryResponse = {
  period: UsagePeriod;
  summary: UsageSummaryItem[];
  totals: Record<UsageUnit, number>;
  quotas: Record<UsageUnit, number | null>;
  totalBytes: number;
  totalQuotaBytes: number | null;
};

function assertQuantity(quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError("quantity must be a non-negative safe integer");
  }
}

function toEpochSeconds(date: Date) {
  return Math.floor(date.getTime() / 1000);
}

export function isUsageService(value: unknown): value is UsageService {
  return typeof value === "string" && usageServices.includes(value as UsageService);
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
    quantity: number;
    action?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
    createdAt?: Date;
  },
) {
  assertQuantity(event.quantity);
  const unit = serviceUnits[event.service];
  const result = await env.DB.prepare(
    `INSERT INTO usage_event
       (id, user_id, service, action, quantity, unit, idempotency_key, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      event.userId,
      event.service,
      event.action ?? defaultActions[event.service],
      event.quantity,
      unit,
      event.idempotencyKey ?? null,
      JSON.stringify({ ...event.metadata, unit }),
      toEpochSeconds(event.createdAt ?? new Date()),
    )
    .run();

  return result.meta.changes > 0;
}

export async function getUsageSummary(
  env: Bindings,
  userId: string,
  now = new Date(),
): Promise<UsageSummaryResponse> {
  const period = getCurrentMonthlyUsagePeriod(now);
  const startSeconds = toEpochSeconds(period.start);
  const endSeconds = toEpochSeconds(period.end);
  const [usageResult, quotaResult] = await Promise.all([
    env.DB.prepare(
      `SELECT service, unit, SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END) AS usage
       FROM usage_event
       WHERE user_id = ? AND created_at >= ? AND created_at <= ?
       GROUP BY service, unit`,
    )
      .bind(userId, startSeconds, endSeconds)
      .all<{ service: string; unit: string; usage: number | null }>(),
    env.DB.prepare(
      `SELECT service, unit, limit_value AS quota
       FROM user_quota
       WHERE user_id = ?`,
    )
      .bind(userId)
      .all<{ service: string; unit: string; quota: number }>(),
  ]);

  const usageByKey = new Map(usageResult.results.map((row) => [`${row.service}:${row.unit}`, row.usage ?? 0]));
  const quotaByKey = new Map(quotaResult.results.map((row) => [`${row.service}:${row.unit}`, row.quota]));
  const summary = usageServices.map((service): UsageSummaryItem => {
    const unit = serviceUnits[service];
    const usage = usageByKey.get(`${service}:${unit}`) ?? 0;
    const quota = quotaByKey.get(`${service}:${unit}`) ?? null;
    return {
      service,
      unit,
      usage,
      quota,
      bytes: unit === "bytes" ? usage : 0,
      quotaBytes: unit === "bytes" ? quota : null,
    };
  });
  const totals = { bytes: 0, requests: 0 } satisfies Record<UsageUnit, number>;
  const quotaTotals: Record<UsageUnit, number | null> = { bytes: null, requests: null };
  for (const item of summary) {
    totals[item.unit] += item.usage;
    if (item.quota !== null) quotaTotals[item.unit] = (quotaTotals[item.unit] ?? 0) + item.quota;
  }

  return {
    period: {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      timezone: period.timezone,
    },
    summary,
    totals,
    quotas: quotaTotals,
    totalBytes: totals.bytes,
    totalQuotaBytes: quotaTotals.bytes,
  };
}
