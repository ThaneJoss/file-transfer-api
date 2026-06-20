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
import { createRegistrationContext, normalizeRegistrationName } from "./passkey-registration";
import { createPickup, isPickupVariant, pickupCodePattern } from "./pickups";
import { issueR2Credentials } from "./services/r2";
import { matchSfuRoute, proxySfuRequest } from "./services/sfu";
import { issueTurnCredentials } from "./services/turn";
import { requireSession } from "./session";
import type { AppEnv, Bindings } from "./types";
import { getUsageSummary, recordUsage } from "./usage";

export { PickupSession } from "./durable/pickup-session";

const app = new Hono<AppEnv>();
const maxJsonBodyBytes = 64 * 1024;

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

async function readJsonObject(c: Context<AppEnv>) {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    return { error: c.json({ error: "Content-Type must be application/json" }, 415) };
  }

  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxJsonBodyBytes) {
    return { error: c.json({ error: "Request body too large" }, 413) };
  }

  try {
    const body = await c.req.text();
    if (new TextEncoder().encode(body).byteLength > maxJsonBodyBytes) {
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
    allowHeaders: ["Content-Type", "Authorization"],
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

app.use("/v1/*", requireSession);

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
  if (service !== "direct" && service !== "stun") {
    return c.json({ error: "service must be direct or stun" }, 400);
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
    metadata: { source: "completed_data_channel_transfer", transferId },
  });
  return recorded ? c.json({ recorded: true }, 201) : c.json({ recorded: false }, 200);
});

app.get("/v1/pickups/:code/answer", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).getAnswer(userId);
  await recordUsage(c.env, {
    userId,
    service: "durable",
    quantity: 1,
    metadata: { operation: "get_answer" },
  });
  if (result.status === "forbidden") return c.json({ error: "Pickup code does not belong to this user" }, 403);
  if (result.status === "found") return c.json({ answer: result.answer });
  return c.json({ error: "Pickup code not found or expired" }, 404);
});

app.put("/v1/pickups/:code/answer", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const parsed = await readJsonObject(c);
  if ("error" in parsed) return parsed.error;
  if (Object.keys(parsed.value).length !== 1 || typeof parsed.value.answer !== "string") {
    return c.json({ error: "Request body must contain only answer" }, 400);
  }
  const answer = parsed.value.answer.trim();
  if (!answer || answer.length > 60_000) return c.json({ error: "answer must be 1 to 60000 characters" }, 400);
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).submitAnswer(userId, answer);
  await recordUsage(c.env, {
    userId,
    service: "durable",
    quantity: 1,
    metadata: { operation: "submit_answer" },
  });
  if (result.status === "answered") return c.json({ error: "Pickup code already has an answer" }, 409);
  if (result.status !== "ok") return c.json({ error: "Pickup code not found or expired" }, 404);
  return c.json({ accepted: true });
});

app.get("/v1/pickups/:code", async (c) => {
  const code = c.req.param("code");
  if (!pickupCodePattern.test(code)) return c.json({ error: "Pickup code must contain exactly 8 digits" }, 400);
  const { userId } = c.get("auth");
  const result = await c.env.PICKUP_SESSIONS.getByName(code).getOffer();
  await recordUsage(c.env, {
    userId,
    service: "durable",
    quantity: 1,
    metadata: { operation: "get_offer" },
  });
  if (result.status !== "found") return c.json({ error: "Pickup code not found or expired" }, 404);
  return c.json(result);
});

app.post("/v1/pickups", async (c) => {
  const parsed = await readJsonObject(c);
  if ("error" in parsed) return parsed.error;
  if (Object.keys(parsed.value).some((key) => key !== "variant" && key !== "offer")) {
    return c.json({ error: "Request body may only contain variant and offer" }, 400);
  }
  const offer = typeof parsed.value.offer === "string" ? parsed.value.offer.trim() : "";
  if (!isPickupVariant(parsed.value.variant)) return c.json({ error: "variant must be direct or stun" }, 400);
  if (!offer || offer.length > 60_000) return c.json({ error: "offer must be 1 to 60000 characters" }, 400);
  const { userId } = c.get("auth");
  const pickup = await createPickup(c.env, {
    senderUserId: userId,
    variant: parsed.value.variant,
    offer,
  });
  await recordUsage(c.env, {
    userId,
    service: "durable",
    quantity: 1,
    metadata: { operation: "create_pickup" },
  });
  return c.json(pickup, 201);
});

app.post("/v1/turn/credentials", async (c) => {
  const parsed = await readJsonObject(c);
  if ("error" in parsed) {
    return parsed.error;
  }

  const ttlSeconds = integerInRange(parsed.value.ttlSeconds, 3600, 60, 86400);
  if (ttlSeconds === null) {
    return c.json({ error: "ttlSeconds must be an integer from 60 to 86400" }, 400);
  }
  const fileSizeBytes = optionalByteCount(parsed.value.fileSizeBytes);
  if (fileSizeBytes === null) {
    return c.json({ error: "fileSizeBytes must be a non-negative safe integer" }, 400);
  }

  try {
    const { userId } = c.get("auth");
    const credentials = await issueTurnCredentials(c.env, ttlSeconds);
    if (fileSizeBytes !== undefined) {
      await recordUsage(c.env, {
        userId,
        service: "turn",
        quantity: fileSizeBytes,
        action: "turn.relay.bytes",
        metadata: {
          ttlSeconds,
          source: "declared_file_size",
        },
      });
    }
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
  if (!fileName || fileName.length > 255) {
    return c.json({ error: "fileName must be a non-empty string up to 255 characters" }, 400);
  }
  if (ttlSeconds === null) {
    return c.json({ error: "ttlSeconds must be an integer from 60 to 3600" }, 400);
  }
  const fileSizeBytes = optionalByteCount(parsed.value.fileSizeBytes);
  if (fileSizeBytes === null) {
    return c.json({ error: "fileSizeBytes must be a non-negative safe integer" }, 400);
  }

  try {
    const { userId } = c.get("auth");
    const credentials = await issueR2Credentials(c.env, {
      userId,
      fileName,
      ttlSeconds,
    });
    if (fileSizeBytes !== undefined) {
      await recordUsage(c.env, {
        userId,
        service: "r2",
        quantity: fileSizeBytes,
        action: "r2.upload.bytes",
        metadata: {
          fileName,
          objectKey: credentials.objectKey,
          ttlSeconds,
          source: "declared_file_size",
        },
      });
    }
    return c.json(credentials, 201);
  } catch (error) {
    logUpstreamError("r2", error);
    return c.json({ error: "R2 credential service unavailable" }, 502);
  }
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
  if (Number.isFinite(declaredLength) && declaredLength > maxJsonBodyBytes) {
    return c.json({ error: "Request body too large" }, 413);
  }

  const body = await c.req.text();
  if (new TextEncoder().encode(body).byteLength > maxJsonBodyBytes) {
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

export default app;
