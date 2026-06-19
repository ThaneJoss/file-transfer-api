import type { Bindings } from "../types";

type R2TemporaryCredentialsResponse = {
  success?: boolean;
  result?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  errors?: Array<{ message?: string }>;
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

export async function issueR2Credentials(
  env: Bindings,
  input: {
    userId: string;
    fileName: string;
    ttlSeconds: number;
  },
) {
  const objectKey = buildObjectKey(input.userId, input.fileName);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.R2_ACCOUNT_ID)}/r2/temp-access-credentials`,
    {
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
    },
  );
  const data = (await response.json().catch(() => ({}))) as R2TemporaryCredentialsResponse;
  const credentials = data.result;

  if (
    !response.ok ||
    data.success !== true ||
    !credentials?.accessKeyId ||
    !credentials.secretAccessKey ||
    !credentials.sessionToken
  ) {
    const details = data.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(details || `R2 API returned HTTP ${response.status}`);
  }

  return {
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    objectKey,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
  };
}
