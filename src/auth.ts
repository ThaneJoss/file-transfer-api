import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import {
  consumeRegistrationContext,
  RegistrationContextError,
  resolveRegistrationContext,
} from "./passkey-registration";
import type { Bindings } from "./types";

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

export function resolveWebAuthnRelyingParty(appOrigin: string) {
  const origin = new URL(appOrigin);
  return { origin: origin.origin, rpID: origin.hostname };
}

export function createAuth(env: Bindings) {
  const db = drizzle(env.DB, { schema });
  const relyingParty = resolveWebAuthnRelyingParty(env.APP_ORIGIN);

  function invalidRegistrationContext(error: unknown): never {
    if (error instanceof RegistrationContextError) {
      throw new APIError("BAD_REQUEST", {
        code: "INVALID_REGISTRATION_CONTEXT",
        message: error.message,
      });
    }
    throw error;
  }

  return betterAuth({
    appName: "file-transfer-api",
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.BETTER_AUTH_URL, env.APP_ORIGIN].filter(isString),
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/passkey/verify-registration" || isAPIError(ctx.context.returned)) {
          return;
        }
        const registered = ctx.context.returned as { userId?: unknown } | undefined;
        if (typeof registered?.userId !== "string" || (await getSessionFromCtx(ctx))) {
          return;
        }
        const user = await ctx.context.internalAdapter.findUserById(registered.userId);
        if (!user) {
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "Passkey user not found" });
        }
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) {
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "Unable to create session" });
        }
        await setSessionCookie(ctx, { session, user });
      }),
    },
    plugins: [
      passkey({
        rpName: "File Transfer",
        rpID: relyingParty.rpID,
        origin: relyingParty.origin,
        registration: {
          requireSession: false,
          resolveUser: async ({ context }) => {
            try {
              const identity = await resolveRegistrationContext(
                env.DB,
                env.BETTER_AUTH_SECRET,
                context,
              );
              return {
                id: identity.userId,
                name: identity.name,
                displayName: identity.name,
              };
            } catch (error) {
              return invalidRegistrationContext(error);
            }
          },
          afterVerification: async ({ ctx, context, user }) => {
            let identity;
            try {
              identity = await consumeRegistrationContext(
                env.DB,
                env.BETTER_AUTH_SECRET,
                context,
              );
            } catch (error) {
              return invalidRegistrationContext(error);
            }
            if (identity.userId !== user.id) {
              throw new APIError("BAD_REQUEST", { message: "Registration identity mismatch" });
            }
            const existingUser = await ctx.context.internalAdapter.findUserById(identity.userId);
            if (existingUser) {
              throw new APIError("BAD_REQUEST", { message: "Registration context already used" });
            }
            const createdUser = await ctx.context.internalAdapter.createUser({
              id: identity.userId,
              name: identity.name,
              email: identity.email,
              emailVerified: true,
            });
            return { userId: createdUser.id };
          },
        },
      }),
    ],
  });
}
