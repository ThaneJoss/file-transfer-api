import type { Bindings } from "../types";

type R2TemporaryCredentialResponse = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
};

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

function summarizeCloudflareErrors(body: R2TemporaryCredentialResponse) {
  const errors = body.errors ?? [];
  return errors
    .map((error) => [error.code, error.message].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("; ");
}

async function parseTemporaryCredentialResponse(response: Response) {
  const body = await response.json<R2TemporaryCredentialResponse>().catch(() => null);
  if (!response.ok || !body?.success) {
    const message = body ? summarizeCloudflareErrors(body) : "";
    throw new Error(`R2 temporary credentials API failed: HTTP ${response.status}${message ? ` ${message}` : ""}`);
  }

  const result = body.result;
  if (!result?.accessKeyId || !result.secretAccessKey || !result.sessionToken) {
    throw new Error("R2 temporary credentials API returned an incomplete credential set");
  }
  return result;
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
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.R2_ACCOUNT_ID}/r2/temp-access-credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.R2_PARENT_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bucket: env.R2_BUCKET,
      parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID,
      permission: "object-read-write",
      ttlSeconds: input.ttlSeconds,
      objects: [objectKey],
    }),
  });
  const temporaryCredentials = await parseTemporaryCredentialResponse(response);

  return {
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    endpoint,
    objectKey,
    accessKeyId: temporaryCredentials.accessKeyId,
    secretAccessKey: temporaryCredentials.secretAccessKey,
    sessionToken: temporaryCredentials.sessionToken,
    expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
  };
}
