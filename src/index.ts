import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  adminHtmlResponse,
  adminScriptResponse,
  adminStyleResponse,
  getAdminStats,
  getAdminUsers,
  parseAdminRange,
  setAdminQuota,
} from "./admin";
import { createAuth } from "./auth";
import { consumeGuestClaimRateLimit, issuePickupGuestToken } from "./guest";
import { createRegistrationContext, normalizeRegistrationName } from "./passkey-registration";
import { createPickup, isPickupRoute, isPickupVariant, pickupCodePattern } from "./pickups";
import { isOwnedR2ObjectKey, issueR2Credentials } from "./services/r2";
import { matchSfuRoute, proxySfuRequest } from "./services/sfu";
import { issueTurnCredentials } from "./services/turn";
import { requireSessionOrPickupGuest } from "./session";
import type { AppEnv, Bindings } from "./types";
import { getUsageSummary, recordUsage } from "./usage";

export { PickupSession } from "./durable/pickup-session";

const app = new Hono<AppEnv>();
const defaultMaxJsonBodyBytes = 64 * 1024;
const maxPickupSignalBytes = 384 * 1024;
// Leave room for the JSON field name and escaping around a full-size signal.
const maxPickupJsonBodyBytes = maxPickupSignalBytes + 1024;

app.use("*", async (c, next) => {
  await next();
  const adminPage = c.req.path === "/admin" || c.req.path.startsWith("/admin/");
  c.header(
    "Content-Security-Policy",
    adminPage
      ? "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; form-action 'self'"
      : "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", adminPage ? "same-origin" : "cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  if (c.req.path.startsWith("/v1/") || c.req.path.startsWith("/api/auth/")) {
    c.header("Cache-Control", "no-store");
  }
});

function allowedOrigins(env: Bindings) {
  return [
    env.BETTER_AUTH_URL,
    env.APP_ORIGIN,
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8787",
  ].filter((origin): origin is string => Boolean(origin));
}

function integerInRange(value: unknown, fallback: number, min: number, max: number) {
  if (value === undefined) {
    return fallback;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function optionalByteCount(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function waitMilliseconds(c: Context<AppEnv>) {
  const value = c.req.query("wait");
  const waitMs = value === undefined ? 0 : Number(value);
  return Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 25_000 ? waitMs : null;
}

async function recordPickupUsage(c: Context<AppEnv>, operation: string) {
  const auth = c.get("auth");
  if (auth.kind === "guest") return;
  await recordUsage(c.env, {
    userId: auth.userId,
    service: "durable",
    quantity: 1,
    metadata: { operation },
  });
}

async function readJsonObject(c: Context<AppEnv>, maxBytes = defaultMaxJsonBodyBytes) {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    return { error: c.json({ error: "Content-Type must be application/json" }, 415) };
  }

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { error: c.json({ error: "Request body too large" }, 413) };
  }

  try {
    const body = await c.req.text();
    if (new TextEncoder().encode(body).byteLength > maxBytes) {
      return { error: c.json({ error: "Request body too large" }, 413) };
    }
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: c.json({ error: "JSON object required" }, 400) };
    }
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: c.json({ error: "Invalid JSON" }, 400) };
  }
}

function logUpstreamError(service: string, error: unknown) {
  console.error(
    JSON.stringify({
      event: "upstream_error",
      service,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      if (!origin) {
        return undefined;
      }

      return allowedOrigins(c.env).includes(origin) ? origin : undefined;
    },
    allowHeaders: ["Content-Type", "Authorization", "X-Pickup-Guest-Token"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    credentials: true,
    maxAge: 600,
  }),
);

app.get("/", (c) => {
  return c.json({
    name: "file-transfer-api",
    status: "ok",
    auth: "/api/auth",
    admin: "/admin/",
    health: "/health",
  });
});

app.get("/health", async (c) => {
  const result = await c.env.DB.prepare("select 1 as ok").first<{ ok: number }>();

  return c.json({
    ok: result?.ok === 1,
    db: result?.ok === 1 ? "ok" : "unavailable",
  });
});

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  return createAuth(c.env).handler(c.req.raw);
});

app.get("/admin", (c) => c.redirect("/admin/"));
app.get("/admin/", () => adminHtmlResponse());
app.get("/admin/admin.js", () => adminScriptResponse());
app.get("/admin/admin.css", () => adminStyleResponse());
app.get("/admin/api/stats", async (c) => {
  const range = parseAdminRange(new URL(c.req.url));
  if (!range) return c.json({ error: "Invalid time range or bucket" }, 400);
  return c.json(await getAdminStats(c.env, range));
});
app.get("/admin/api/users", async (c) => c.json(await getAdminUsers(c.env)));
app.put("/admin/api/users/:userId/quota", async (c) => {
  const parsed = await readJsonObject(c);
  if ("error" in parsed) return parsed.error;
  if (Object.keys(parsed.value).some((key) => key !== "service" && key !== "limit")) {
    return c.json({ error: "Request body may only contain service and limit" }, 400);
  }
  const result = await setAdminQuota(
    c.env,
    c.req.param("userId"),
    parsed.value.service,
    parsed.value.limit,
  );
  if ("error" in result) return c.json({ error: result.error }, result.status);
  return c.json(result);
});

app.use("/v1/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && !allowedOrigins(c.env).includes(origin)) {
    return c.json({ error: "Origin not allowed" }, 403);
  }
  await next();
});

app.post("/v1/passkey/registration-context", async (c) => {
  const parsed = await readJsonObject(c);
  if ("error" in parsed) {
    return parsed.error;
  }
  if (Object.keys(parsed.value).length !== 1) {
    return c.json({ error: "Request body must contain only name" }, 400);
  }
  const name = normalizeRegistrationName(parsed.value.name);
  if (!name) {
    return c.json({ error: "name must be a non-empty string up to 80 characters" }, 400);
  }
  const context = await createRegistrationContext(
    c.env.DB,
    c.env.BETTER_AUTH_SECRET,
    name,
  );
  return c.json({ context }, 201);
});

app.post("/v1/pickups/:code/guest", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);

  const rateLimit = await consumeGuestClaimRateLimit(
    c.env,
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? "unknown",
  );
  if (!rateLimit.allowed) {
    c.header("Retry-After", String(rateLimit.retryAfterSeconds));
    return c.json({ error: "Too many guest pickup attempts" }, 429);
  }

  const pickup = await c.env.PICKUP_SESSIONS.getByName(code).getOffer(0);
  if (pickup.status === "cancelled") return c.json({ error: "Pickup transfer was cancelled" }, 410);
  if (pickup.status !== "found" && pickup.status !== "pending") {
    return c.json({ error: "Pickup code not found or expired" }, 404);
  }
  const guest = await issuePickupGuestToken(c.env.BETTER_AUTH_SECRET, code, pickup.expiresAt);
  return c.json({ token: guest.token, expiresAt: guest.expiresAt, pickup }, 201);
});

app.use("/v1/*", requireSessionOrPickupGuest);

app.get("/v1/me", async (c) => {
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });

  return c.json(session);
});

app.get("/v1/usage", async (c) => {
  const { userId } = c.get("auth");
  const usage = await getUsageSummary(c.env, userId);

  return c.json(usage);
});

app.post("/v1/usage/transfers", async (c) => {
  const parsed = await readJsonObject(c);
  if ("error" in parsed) return parsed.error;
  if (Object.keys(parsed.value).some((key) => !["service", "bytes", "transferId"].includes(key))) {
    return c.json({ error: "Request body may only contain service, bytes and transferId" }, 400);
  }
  const service = parsed.value.service;
  const bytes = optionalByteCount(parsed.value.bytes);
  const transferId = typeof parsed.value.transferId === "string" ? parsed.value.transferId.trim() : "";
  if (
    service !== "direct" &&
    service !== "stun" &&
    service !== "turn" &&
    service !== "sfu" &&
    service !== "r2"
  ) {
    return c.json({ error: "service must be direct, stun, turn, sfu or r2" }, 400);
  }
  if (bytes === null || bytes === undefined) {
    return c.json({ error: "bytes must be a non-negative safe integer" }, 400);
  }
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(transferId)) {
    return c.json({ error: "transferId must be 16 to 100 URL-safe characters" }, 400);
  }
  const { userId } = c.get("auth");
  const recorded = await recordUsage(c.env, {
    userId,
    service,
    quantity: bytes,
    idempotencyKey: `${userId}:${service}:${transferId}`,
    metadata: { source: "verified_winner_payload", transferId },
  });
  return recorded ? c.json({ recorded: true }, 201) : c.json({ recorded: false }, 200);
});

app.get("/v1/pickups/:code/status", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const waitMs = waitMilliseconds(c);
  if (waitMs === null) return c.json({ error: "wait must be an integer from 0 to 25000 milliseconds" }, 400);
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).getStatus(userId, waitMs);
  await recordPickupUsage(c, "get_status");
  if (result.status === "forbidden") return c.json({ error: "Pickup code does not belong to this transfer" }, 403);
  if (result.status === "found") {
    return c.json({ cancelled: result.cancelled, expiresAt: result.expiresAt });
  }
  return c.json({ error: "Pickup code not found or expired" }, 404);
});

app.put("/v1/pickups/:code/cancel", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).cancel(userId);
  await recordPickupUsage(c, "cancel");
  if (result.status === "forbidden") return c.json({ error: "Pickup code does not belong to this transfer" }, 403);
  if (result.status === "won") return c.json({ error: "Pickup code already has a winning route" }, 409);
  if (result.status !== "ok") return c.json({ error: "Pickup code not found or expired" }, 404);
  return c.json({ cancelled: true });
});

app.get("/v1/pickups/:code/selection", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const waitMs = waitMilliseconds(c);
  if (waitMs === null) return c.json({ error: "wait must be an integer from 0 to 25000 milliseconds" }, 400);
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).getSelection(userId, waitMs);
  await recordPickupUsage(c, "get_selection");
  if (result.status === "forbidden") return c.json({ error: "Pickup code is not bound to this receiver" }, 403);
  if (result.status === "cancelled") return c.json({ error: "Pickup transfer was cancelled" }, 410);
  if (result.status === "found" && result.route !== null) return c.json({ route: result.route });
  if (result.status === "found") return c.json({ error: "Pickup route not selected yet" }, 404);
  return c.json({ error: "Pickup code not found or expired" }, 404);
});

app.put("/v1/pickups/:code/selection", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const parsed = await readJsonObject(c);
  if ("error" in parsed) return parsed.error;
  if (Object.keys(parsed.value).length !== 1 || !isPickupRoute(parsed.value.route)) {
    return c.json({ error: "Request body must contain only route (direct, stun, turn, sfu or r2)" }, 400);
  }
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).submitSelection(userId, parsed.value.route);
  await recordPickupUsage(c, "submit_selection");
  if (result.status === "forbidden") return c.json({ error: "Pickup code does not belong to this user" }, 403);
  if (result.status === "cancelled") return c.json({ error: "Pickup transfer was cancelled" }, 410);
  if (result.status === "won") return c.json({ error: "Pickup code already has a winning route" }, 409);
  if (result.status !== "ok") return c.json({ error: "Pickup code not found or expired" }, 404);
  return c.json({ accepted: true });
});

app.get("/v1/pickups/:code/winner", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const waitMs = waitMilliseconds(c);
  if (waitMs === null) return c.json({ error: "wait must be an integer from 0 to 25000 milliseconds" }, 400);
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).getWinner(userId, waitMs);
  await recordPickupUsage(c, "get_winner");
  if (result.status === "forbidden") return c.json({ error: "Pickup code does not belong to this user" }, 403);
  if (result.status === "cancelled") return c.json({ error: "Pickup transfer was cancelled" }, 410);
  if (result.status === "found" && result.winner !== null) return c.json(result.winner);
  if (result.status === "found") return c.json({ error: "Pickup winner not confirmed yet" }, 404);
  return c.json({ error: "Pickup code not found or expired" }, 404);
});

app.put("/v1/pickups/:code/winner", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const parsed = await readJsonObject(c);
  if ("error" in parsed) return parsed.error;
  const keys = Object.keys(parsed.value);
  if (
    keys.length !== 3 ||
    !keys.every((key) => key === "route" || key === "bytes" || key === "sha256") ||
    !isPickupRoute(parsed.value.route) ||
    optionalByteCount(parsed.value.bytes) === null ||
    optionalByteCount(parsed.value.bytes) === undefined ||
    typeof parsed.value.sha256 !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(parsed.value.sha256)
  ) {
    return c.json({ error: "Request body must contain route, non-negative integer bytes and a 64-character SHA-256" }, 400);
  }
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).submitWinner(userId, {
    route: parsed.value.route,
    bytes: parsed.value.bytes as number,
    sha256: parsed.value.sha256.toLowerCase(),
  });
  await recordPickupUsage(c, "submit_winner");
  if (result.status === "forbidden") return c.json({ error: "Pickup code is not bound to this receiver" }, 403);
  if (result.status === "cancelled") return c.json({ error: "Pickup transfer was cancelled" }, 410);
  if (result.status === "won") return c.json({ error: "Pickup code already has a winning route" }, 409);
  if (result.status !== "ok") return c.json({ error: "Pickup code not found or expired" }, 404);
  return c.json({ accepted: true });
});

app.get("/v1/pickups/:code/answer", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const waitMs = waitMilliseconds(c);
  if (waitMs === null) return c.json({ error: "wait must be an integer from 0 to 25000 milliseconds" }, 400);
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).getAnswer(userId, waitMs);
  await recordPickupUsage(c, "get_answer");
  if (result.status === "forbidden") return c.json({ error: "Pickup code does not belong to this user" }, 403);
  if (result.status === "cancelled") return c.json({ error: "Pickup transfer was cancelled" }, 410);
  if (result.status === "found") return c.json({ answer: result.answer });
  return c.json({ error: "Pickup code not found or expired" }, 404);
});

app.put("/v1/pickups/:code/answer", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const parsed = await readJsonObject(c, maxPickupJsonBodyBytes);
  if ("error" in parsed) return parsed.error;
  if (Object.keys(parsed.value).length !== 1 || typeof parsed.value.answer !== "string") {
    return c.json({ error: "Request body must contain only answer" }, 400);
  }
  const answer = parsed.value.answer.trim();
  if (!answer || utf8ByteLength(answer) > maxPickupSignalBytes) {
    return c.json({ error: "answer must be 1 to 393216 UTF-8 bytes" }, 400);
  }
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).submitAnswer(userId, answer);
  await recordPickupUsage(c, "submit_answer");
  if (result.status === "cancelled") return c.json({ error: "Pickup transfer was cancelled" }, 410);
  if (result.status === "pending") return c.json({ error: "Pickup offer is not ready yet" }, 409);
  if (result.status === "answered") return c.json({ error: "Pickup code already has an answer" }, 409);
  if (result.status !== "ok") return c.json({ error: "Pickup code not found or expired" }, 404);
  return c.json({ accepted: true });
});

app.put("/v1/pickups/:code/offer", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const parsed = await readJsonObject(c, maxPickupJsonBodyBytes);
  if ("error" in parsed) return parsed.error;
  if (Object.keys(parsed.value).length !== 1 || typeof parsed.value.offer !== "string") {
    return c.json({ error: "Request body must contain only offer" }, 400);
  }
  const offer = parsed.value.offer.trim();
  if (!offer || utf8ByteLength(offer) > maxPickupSignalBytes) {
    return c.json({ error: "offer must be 1 to 393216 UTF-8 bytes" }, 400);
  }
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).publishOffer(userId, offer);
  await recordPickupUsage(c, "publish_offer");
  if (result.status === "forbidden") return c.json({ error: "Pickup code does not belong to this user" }, 403);
  if (result.status === "cancelled") return c.json({ error: "Pickup transfer was cancelled" }, 410);
  if (result.status === "published") return c.json({ error: "Pickup offer was already published" }, 409);
  if (result.status === "answered") return c.json({ error: "Pickup code already has an answer" }, 409);
  if (result.status !== "ok") return c.json({ error: "Pickup code not found or expired" }, 404);
  return c.json({ accepted: true });
});

app.get("/v1/pickups/:code", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const waitMs = waitMilliseconds(c);
  if (waitMs === null) {
    return c.json({ error: "wait must be an integer from 0 to 25000 milliseconds" }, 400);
  }
  const result = await c.env.PICKUP_SESSIONS.getByName(code).getOffer(waitMs);
  await recordPickupUsage(c, "get_offer");
  if (result.status === "cancelled") return c.json({ error: "Pickup transfer was cancelled" }, 410);
  if (result.status === "pending") return c.json(result, 202);
  if (result.status !== "found") return c.json({ error: "Pickup code not found or expired" }, 404);
  return c.json(result);
});

app.post("/v1/pickups", async (c) => {
  const parsed = await readJsonObject(c, maxPickupJsonBodyBytes);
  if ("error" in parsed) return parsed.error;
  if (Object.keys(parsed.value).some((key) => key !== "variant" && key !== "offer")) {
    return c.json({ error: "Request body may only contain variant and offer" }, 400);
  }
  if (parsed.value.offer !== undefined && typeof parsed.value.offer !== "string") {
    return c.json({ error: "offer must be a string when provided" }, 400);
  }
  const offer = typeof parsed.value.offer === "string" ? parsed.value.offer.trim() : undefined;
  if (!isPickupVariant(parsed.value.variant)) {
    return c.json({ error: "variant must be direct, stun, turn, sfu, r2 or multipath" }, 400);
  }
  if (offer !== undefined && (!offer || utf8ByteLength(offer) > maxPickupSignalBytes)) {
    return c.json({ error: "offer must be 1 to 393216 UTF-8 bytes" }, 400);
  }
  const { userId } = c.get("auth");
  const pickup = await createPickup(c.env, {
    senderUserId: userId,
    variant: parsed.value.variant,
    ...(offer === undefined ? {} : { offer }),
  });
  await recordPickupUsage(c, "create_pickup");
  return c.json(pickup, 201);
});

app.post("/v1/turn/credentials", async (c) => {
  const parsed = await readJsonObject(c);
  if ("error" in parsed) {
    return parsed.error;
  }

  let ttlSeconds = integerInRange(parsed.value.ttlSeconds, 3600, 60, 86400);
  if (ttlSeconds === null) {
    return c.json({ error: "ttlSeconds must be an integer from 60 to 86400" }, 400);
  }
  if (optionalByteCount(parsed.value.fileSizeBytes) === null) {
    return c.json({ error: "fileSizeBytes must be a non-negative safe integer" }, 400);
  }

  const auth = c.get("auth");
  if (auth.kind === "guest") {
    const remainingTtlSeconds = Math.floor((auth.expiresAt - Date.now()) / 1000);
    if (remainingTtlSeconds < 60) {
      return c.json({ error: "Pickup guest token expires too soon to issue TURN credentials" }, 403);
    }
    ttlSeconds = Math.min(ttlSeconds, remainingTtlSeconds);
  }

  try {
    const credentials = await issueTurnCredentials(c.env, ttlSeconds);
    return c.json(credentials, 201);
  } catch (error) {
    logUpstreamError("turn", error);
    return c.json({ error: "TURN credential service unavailable" }, 502);
  }
});

app.post("/v1/r2/credentials", async (c) => {
  const parsed = await readJsonObject(c);
  if ("error" in parsed) {
    return parsed.error;
  }

  const fileName = typeof parsed.value.fileName === "string" ? parsed.value.fileName.trim() : "";
  const ttlSeconds = integerInRange(parsed.value.ttlSeconds, 900, 60, 3600);
  const requestedObjectKey = typeof parsed.value.objectKey === "string" ? parsed.value.objectKey.trim() : undefined;
  if (!fileName || fileName.length > 255) {
    return c.json({ error: "fileName must be a non-empty string up to 255 characters" }, 400);
  }
  if (ttlSeconds === null) {
    return c.json({ error: "ttlSeconds must be an integer from 60 to 3600" }, 400);
  }
  if (optionalByteCount(parsed.value.fileSizeBytes) === null) {
    return c.json({ error: "fileSizeBytes must be a non-negative safe integer" }, 400);
  }

  try {
    const { userId } = c.get("auth");
    if (requestedObjectKey !== undefined && !isOwnedR2ObjectKey(userId, requestedObjectKey)) {
      return c.json({ error: "objectKey does not belong to this user" }, 403);
    }
    const credentials = await issueR2Credentials(c.env, {
      userId,
      fileName,
      ttlSeconds,
      ...(requestedObjectKey === undefined ? {} : { objectKey: requestedObjectKey }),
    });
    return c.json(credentials, 201);
  } catch (error) {
    logUpstreamError("r2", error);
    return c.json({ error: "R2 credential service unavailable" }, 502);
  }
});

app.post("/v1/diagnostics/transfers", async (c) => {
  const parsed = await readJsonObject(c, 12 * 1024);
  if ("error" in parsed) return parsed.error;
  const value = parsed.value;
  const allowedKeys = new Set([
    "id", "side", "outcome", "mode", "winner", "durationMs", "errorCode", "capabilities", "routes",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return c.json({ error: "Diagnostic payload contains unsupported fields" }, 400);
  }
  if (
    typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id) ||
    (value.side !== "sender" && value.side !== "receiver") ||
    (value.outcome !== "complete" && value.outcome !== "error" && value.outcome !== "cancelled") ||
    (value.mode !== null && value.mode !== "auto" && value.mode !== "turbo" && value.mode !== "legacy") ||
    (value.winner !== null && !isPickupRoute(value.winner)) ||
    typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 86_400_000 ||
    (value.errorCode !== null && (typeof value.errorCode !== "string" || !/^[A-Z0-9_]{2,64}$/.test(value.errorCode))) ||
    !isDiagnosticCapabilities(value.capabilities) ||
    !isDiagnosticRoutes(value.routes)
  ) return c.json({ error: "Diagnostic payload is invalid" }, 400);

  const auth = c.get("auth");
  console.log(JSON.stringify({
    event: "transfer_diagnostic",
    actorKind: auth.kind,
    id: value.id,
    side: value.side,
    outcome: value.outcome,
    mode: value.mode,
    winner: value.winner,
    durationMs: Math.round(value.durationMs),
    errorCode: value.errorCode,
    capabilities: value.capabilities,
    routes: value.routes,
  }));
  return c.json({ accepted: true }, 202);
});

app.all("/v1/sfu/*", async (c) => {
  const path = c.req.path.slice("/v1/sfu".length);
  const route = matchSfuRoute(path, c.req.method);
  if (!route) {
    return c.json({ error: "SFU operation not allowed" }, 404);
  }
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    return c.json({ error: "Content-Type must be application/json" }, 415);
  }

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > defaultMaxJsonBodyBytes) {
    return c.json({ error: "Request body too large" }, 413);
  }

  const body = await c.req.text();
  if (new TextEncoder().encode(body).byteLength > defaultMaxJsonBodyBytes) {
    return c.json({ error: "Request body too large" }, 413);
  }

  try {
    const response = await proxySfuRequest(c.env, path, route.method, body);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    logUpstreamError("sfu", error);
    return c.json({ error: "SFU service unavailable" }, 502);
  }
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

function isDiagnosticCapabilities(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => ["rtc", "fileSystem", "worker"].includes(key)) &&
    ["rtc", "fileSystem", "worker"].every((key) => typeof record[key] === "boolean");
}

function isDiagnosticRoutes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowedStates = new Set(["preparing", "ready", "probing", "selected", "transferring", "complete", "failed"]);
  return Object.entries(value as Record<string, unknown>).every(([route, state]) =>
    isPickupRoute(route) && typeof state === "string" && allowedStates.has(state),
  );
}

export default app;
