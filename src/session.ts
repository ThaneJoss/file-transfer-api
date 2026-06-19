import type { MiddlewareHandler } from "hono";
import { createAuth } from "./auth";
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
  });
  await next();
};
