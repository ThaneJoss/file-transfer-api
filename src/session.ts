import type { MiddlewareHandler } from "hono";
import { createAuth } from "./auth";
import { verifyPickupGuestToken } from "./guest";
import type { AppEnv } from "./types";

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authSession = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });

  if (!authSession) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("auth", {
    userId: authSession.user.id,
    sessionId: authSession.session.id,
    kind: "session",
  });
  await next();
};

export const requireSessionOrPickupGuest: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authSession = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (authSession) {
    c.set("auth", {
      userId: authSession.user.id,
      sessionId: authSession.session.id,
      kind: "session",
    });
    await next();
    return;
  }

  const token = c.req.header("x-pickup-guest-token")?.trim();
  const guest = token ? await verifyPickupGuestToken(c.env.BETTER_AUTH_SECRET, token) : null;
  if (!guest || !guestRequestAllowed(c.req.path, c.req.method, guest.pickupCode)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("auth", {
    userId: guest.actorId,
    sessionId: guest.actorId,
    kind: "guest",
    pickupCode: guest.pickupCode,
    expiresAt: guest.expiresAt,
  });
  await next();
};

function guestRequestAllowed(path: string, method: string, pickupCode: string) {
  if (method === "POST" && (
    path === "/v1/turn/credentials" ||
    path === "/v1/diagnostics/transfers"
  )) return true;
  if (path.startsWith("/v1/sfu/")) return true;

  const base = `/v1/pickups/${pickupCode}`;
  if (method === "GET" && (path === base || path === `${base}/selection` || path === `${base}/status`)) return true;
  if (method === "PUT" && (path === `${base}/answer` || path === `${base}/winner` || path === `${base}/cancel`)) return true;
  return false;
}
