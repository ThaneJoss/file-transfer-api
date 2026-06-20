import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import { createRegistrationContext, normalizeRegistrationName } from "./passkey-registration";
import { issueR2Credentials } from "./services/r2";
import { matchSfuRoute, proxySfuRequest } from "./services/sfu";
import { issueTurnCredentials } from "./services/turn";
import { requireSession } from "./session";
import type { AppEnv, Bindings } from "./types";
import { getUsageSummary, recordUsage } from "./usage";

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
    const value = (await c.req.json()) as unknown;
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
        bytes: fileSizeBytes,
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
        bytes: fileSizeBytes,
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
