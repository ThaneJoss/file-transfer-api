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

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function textToBase64Url(value: string) {
  return bytesToBase64Url(encoder.encode(value));
}

function jsonToBase64Url(value: unknown) {
  return textToBase64Url(JSON.stringify(value));
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function resolveParentSecretAccessKey(parentSecretOrToken: string) {
  const trimmed = parentSecretOrToken.trim();
  if (!trimmed) {
    throw new Error("R2 parent secret is not configured");
  }

  return sha256HexPattern.test(trimmed) ? trimmed.toLowerCase() : sha256Hex(trimmed);
}

async function createSignedJwt(claims: Record<string, unknown>, secretAccessKey: string) {
  const unsignedToken = `${jsonToBase64Url({ alg: "HS256", typ: "JWT" })}.${jsonToBase64Url(claims)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretAccessKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(unsignedToken)));

  return `${unsignedToken}.${bytesToBase64Url(signature)}`;
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  const parentSecretAccessKey = await resolveParentSecretAccessKey(env.R2_PARENT_API_TOKEN);
  const jwt = await createSignedJwt(
    {
      bucket: env.R2_BUCKET,
      scope: "object-read-write",
      paths: { objectPaths: [objectKey] },
      sub: env.R2_ACCOUNT_ID,
      iss: env.R2_PARENT_ACCESS_KEY_ID,
      aud: new URL(endpoint).host,
      iat: nowSeconds,
      exp: nowSeconds + input.ttlSeconds,
    },
    parentSecretAccessKey,
  );

  return {
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    endpoint,
    objectKey,
    accessKeyId: env.R2_PARENT_ACCESS_KEY_ID,
    secretAccessKey: await sha256Hex(jwt),
    sessionToken: btoa(`jwt/${jwt}`),
    expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
  };
}
