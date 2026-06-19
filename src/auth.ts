import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import type { Bindings } from "./types";

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

export function createAuth(env: Bindings) {
  const db = drizzle(env.DB, { schema });

  return betterAuth({
    appName: "file-transfer-api",
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.BETTER_AUTH_URL, env.APP_ORIGIN].filter(isString),
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
  });
}
