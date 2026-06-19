import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

function allowedOrigins(env: Bindings) {
  return [
    env.BETTER_AUTH_URL,
    env.APP_ORIGIN,
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8787",
  ].filter((origin): origin is string => Boolean(origin));
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
    allowMethods: ["GET", "POST", "OPTIONS"],
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

app.get("/v1/me", async (c) => {
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json(session);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
