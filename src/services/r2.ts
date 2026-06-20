import { SignJWT } from "jose";

import type { Bindings } from "../types";

const encoder = new TextEncoder();
const sha256HexPattern = /^[a-f0-9]{64}$/iu;

function safePathSegment(value: string, fallback: string) {
  const sanitized = value
    .trim()
    .replace(/[\u0000-\u001f\u007f/\\?#]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);

  return sanitized || fallback;
}

function buildObjectKey(userId: string, fileName: string) {
  const userSegment = safePathSegment(userId, "user");
  const fileSegment = safePathSegment(fileName, "file");
  const date = new Date().toISOString().slice(0, 10);

  return `users/${userSegment}/${date}/${crypto.randomUUID()}-${fileSegment}`;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function resolveParentSecretAccessKey(parentSecretOrToken: string) {
  const value = parentSecretOrToken.trim();
  if (!value) {
    throw new Error("R2 parent secret is not configured");
  }

  return sha256HexPattern.test(value) ? value.toLowerCase() : sha256Hex(value);
}

export async function issueR2Credentials(
  env: Bindings,
  input: {
    userId: string;
    fileName: string;
    ttlSeconds: number;
  },
) {
  const objectKey = buildObjectKey(input.userId, input.fileName);
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const parentSecretAccessKey = await resolveParentSecretAccessKey(env.R2_PARENT_API_TOKEN);
  const sessionJwt = await new SignJWT({
    bucket: env.R2_BUCKET,
    scope: "object-read-write",
    paths: { objectPaths: [objectKey] },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(env.R2_ACCOUNT_ID)
    .setIssuer(env.R2_PARENT_ACCESS_KEY_ID)
    .setAudience(new URL(endpoint).host)
    .setIssuedAt()
    .setExpirationTime(`${input.ttlSeconds}s`)
    .sign(encoder.encode(parentSecretAccessKey));

  return {
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    endpoint,
    objectKey,
    accessKeyId: env.R2_PARENT_ACCESS_KEY_ID,
    secretAccessKey: await sha256Hex(sessionJwt),
    sessionToken: btoa(`jwt/${sessionJwt}`),
    expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
  };
}
