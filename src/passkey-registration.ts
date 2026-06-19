const contextVersion = 1;
export const registrationContextTtlMs = 5 * 60 * 1000;
const tokenPrefix = "passkey-registration-context-v1";
const maxContextLength = 2048;

type ContextPayload = {
  v: 1;
  jti: string;
  iat: number;
  exp: number;
};

export type RegistrationIdentity = {
  contextId: string;
  userId: string;
  name: string;
  email: string;
  expiresAt: number;
};

export class RegistrationContextError extends Error {
  constructor() {
    super("Invalid, expired, or already used registration context");
    this.name = "RegistrationContextError";
  }
}

function encodeBase64Url(value: Uint8Array | string) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new RegistrationContextError();
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new RegistrationContextError();
  }
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function isContextPayload(value: unknown): value is ContextPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).length === 4 &&
    payload.v === contextVersion &&
    typeof payload.jti === "string" &&
    payload.jti.length === 36 &&
    typeof payload.iat === "number" &&
    Number.isSafeInteger(payload.iat) &&
    typeof payload.exp === "number" &&
    Number.isSafeInteger(payload.exp) &&
    payload.exp > payload.iat
  );
}

async function signPayload(payload: ContextPayload, secret: string) {
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signedValue = `${tokenPrefix}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(signedValue),
  );
  return `${signedValue}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifyToken(context: string | null | undefined, secret: string, now: number) {
  if (!context || context.length > maxContextLength) {
    throw new RegistrationContextError();
  }
  const parts = context.split(".");
  if (parts.length !== 3 || parts[0] !== tokenPrefix) {
    throw new RegistrationContextError();
  }

  const signedValue = `${parts[0]}.${parts[1]}`;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(signedValue),
  );
  if (!valid) {
    throw new RegistrationContextError();
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  } catch {
    throw new RegistrationContextError();
  }
  if (!isContextPayload(payload) || payload.iat > now + 30_000 || payload.exp <= now) {
    throw new RegistrationContextError();
  }
  return payload;
}

export function normalizeRegistrationName(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    return null;
  }
  return name;
}

export async function createRegistrationContext(
  db: D1Database,
  secret: string,
  name: string,
  now = Date.now(),
) {
  const contextId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const expiresAt = now + registrationContextTtlMs;
  const email = `passkey-${userId}@internal.file.thanejoss.com`;

  await db
    .prepare(
      `INSERT INTO passkey_registration_context
        (id, user_id, name, email, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(contextId, userId, name, email, expiresAt, now)
    .run();

  return signPayload({ v: contextVersion, jti: contextId, iat: now, exp: expiresAt }, secret);
}

export async function resolveRegistrationContext(
  db: D1Database,
  secret: string,
  context: string | null | undefined,
  now = Date.now(),
): Promise<RegistrationIdentity> {
  const payload = await verifyToken(context, secret, now);
  const row = await db
    .prepare(
      `SELECT id, user_id, name, email, expires_at
       FROM passkey_registration_context
       WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .bind(payload.jti, now)
    .first<{
      id: string;
      user_id: string;
      name: string;
      email: string;
      expires_at: number;
    }>();

  if (!row || row.expires_at !== payload.exp) {
    throw new RegistrationContextError();
  }
  return {
    contextId: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    expiresAt: row.expires_at,
  };
}

export async function consumeRegistrationContext(
  db: D1Database,
  secret: string,
  context: string | null | undefined,
  now = Date.now(),
) {
  const identity = await resolveRegistrationContext(db, secret, context, now);
  const result = await db
    .prepare(
      `UPDATE passkey_registration_context
       SET used_at = ?
       WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .bind(now, identity.contextId, now)
    .run();
  if (result.meta.changes !== 1) {
    throw new RegistrationContextError();
  }
  return identity;
}
