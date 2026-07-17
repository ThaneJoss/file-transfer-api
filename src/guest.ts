import { jwtVerify, SignJWT } from "jose";

import type { Bindings } from "./types";

const encoder = new TextEncoder();
const guestIssuer = "file-transfer-api";
const guestAudience = "file-transfer-pickup-guest";
const guestClaimLimitPerMinute = 12;

export type PickupGuest = {
  actorId: string;
  pickupCode: string;
  expiresAt: number;
};

export async function issuePickupGuestToken(secret: string, pickupCode: string, expiresAt: number) {
  const actorId = `guest:${crypto.randomUUID()}`;
  const token = await new SignJWT({ pickupCode, kind: "pickup-guest" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(guestIssuer)
    .setAudience(guestAudience)
    .setSubject(actorId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .setJti(crypto.randomUUID())
    .sign(encoder.encode(secret));
  return { token, actorId, expiresAt };
}

export async function verifyPickupGuestToken(secret: string, token: string): Promise<PickupGuest | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      issuer: guestIssuer,
      audience: guestAudience,
      algorithms: ["HS256"],
    });
    if (
      payload.kind !== "pickup-guest" ||
      typeof payload.sub !== "string" ||
      !payload.sub.startsWith("guest:") ||
      typeof payload.pickupCode !== "string" ||
      !/^\d{8}$/.test(payload.pickupCode) ||
      typeof payload.exp !== "number"
    ) return null;
    return { actorId: payload.sub, pickupCode: payload.pickupCode, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
}

export async function consumeGuestClaimRateLimit(env: Bindings, clientAddress: string) {
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const clientHash = await sha256Hex(`${env.BETTER_AUTH_SECRET}:${clientAddress || "unknown"}`);
  const statements = [
    env.DB.prepare(
      `INSERT INTO guest_claim_rate_limit (minute_bucket, client_hash, attempts)
       VALUES (?, ?, 1)
       ON CONFLICT (minute_bucket, client_hash)
       DO UPDATE SET attempts = attempts + 1`,
    ).bind(minuteBucket, clientHash),
    env.DB.prepare(
      "SELECT attempts FROM guest_claim_rate_limit WHERE minute_bucket = ? AND client_hash = ?",
    ).bind(minuteBucket, clientHash),
  ];
  const [, lookup] = await env.DB.batch<{ attempts: number }>(statements);
  const attempts = lookup.results[0]?.attempts ?? guestClaimLimitPerMinute + 1;

  // Opportunistic bounded cleanup avoids retaining address hashes beyond the active window.
  if (crypto.getRandomValues(new Uint8Array(1))[0] < 8) {
    await env.DB.prepare("DELETE FROM guest_claim_rate_limit WHERE minute_bucket < ?")
      .bind(minuteBucket - 2)
      .run();
  }
  return { allowed: attempts <= guestClaimLimitPerMinute, retryAfterSeconds: 60 };
}

function sha256Hex(value: string) {
  return crypto.subtle.digest("SHA-256", encoder.encode(value)).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}
