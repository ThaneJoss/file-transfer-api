import { AwsClient } from "aws4fetch";

const requiredEnv = [
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
  "R2_PARENT_ACCESS_KEY_ID",
  "R2_PARENT_API_TOKEN",
];

const corsHeadersForUpload = [
  "authorization",
  "content-type",
  "x-amz-content-sha256",
  "x-amz-date",
  "x-amz-security-token",
];

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function textSnippet(response) {
  const text = await response.text().catch(() => "");
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function assertHeaderListIncludes(headerValue, expectedValues, label) {
  const normalized = (headerValue ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (normalized.includes("*")) return;

  const missing = expectedValues.filter((value) => !normalized.includes(value.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`${label} missing ${missing.join(", ")}; received ${headerValue || "<empty>"}`);
  }
}

async function assertCorsPreflight({ endpoint, bucket, origin, method, requestHeaders = [] }) {
  const headers = new Headers({
    Origin: origin,
    "Access-Control-Request-Method": method,
  });
  if (requestHeaders.length > 0) {
    headers.set("Access-Control-Request-Headers", requestHeaders.join(", "));
  }

  const response = await fetch(`${endpoint}/${encodePathSegment(bucket)}/__r2_cors_preflight__`, {
    method: "OPTIONS",
    headers,
  });
  if (!response.ok) {
    throw new Error(`R2 CORS ${method} preflight failed: HTTP ${response.status} ${await textSnippet(response)}`);
  }

  const allowOrigin = response.headers.get("access-control-allow-origin");
  if (allowOrigin !== "*" && allowOrigin !== origin) {
    throw new Error(`R2 CORS ${method} preflight rejected origin ${origin}; received ${allowOrigin || "<empty>"}`);
  }

  assertHeaderListIncludes(response.headers.get("access-control-allow-methods"), [method], `R2 CORS ${method} allowed methods`);
  if (requestHeaders.length > 0) {
    assertHeaderListIncludes(response.headers.get("access-control-allow-headers"), requestHeaders, `R2 CORS ${method} allowed headers`);
  }
}

async function assertBucketList({ endpoint, bucket, credentials }) {
  const client = new AwsClient({
    ...credentials,
    service: "s3",
    region: "auto",
    retries: 0,
  });
  const response = await client.fetch(`${endpoint}/${encodePathSegment(bucket)}?list-type=2&max-keys=1`, {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`R2 ListObjectsV2 failed: HTTP ${response.status} ${await textSnippet(response)}`);
  }
}

async function createTemporaryCredentials({ accountId, bucket, parentAccessKeyId, parentApiToken }) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${parentApiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bucket,
      parentAccessKeyId,
      permission: "object-read-write",
      ttlSeconds: 300,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const errors = Array.isArray(body?.errors)
      ? body.errors.map((error) => [error.code, error.message].filter(Boolean).join(" ")).filter(Boolean).join("; ")
      : "";
    throw new Error(`R2 temporary credentials API failed: HTTP ${response.status}${errors ? ` ${errors}` : ""}`);
  }

  const result = body.result;
  if (!result?.accessKeyId || !result.secretAccessKey || !result.sessionToken) {
    throw new Error("R2 temporary credentials API returned an incomplete credential set");
  }
  return result;
}

async function main() {
  const missing = requiredEnv.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(", ")}. Add these to Cloudflare Workers Builds build variables/secrets as well as Worker runtime secrets; runtime secrets are not exposed to deploy scripts.`,
    );
  }

  const accountId = requireEnv("R2_ACCOUNT_ID");
  const bucket = requireEnv("R2_BUCKET");
  const parentAccessKeyId = requireEnv("R2_PARENT_ACCESS_KEY_ID");
  const parentApiToken = requireEnv("R2_PARENT_API_TOKEN");
  const origin = process.env.APP_ORIGIN?.trim() || "https://file.thanejoss.com";
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

  const credentials = await createTemporaryCredentials({ accountId, bucket, parentAccessKeyId, parentApiToken });
  await assertBucketList({ endpoint, bucket, credentials });
  console.log(`R2 ListObjectsV2 preflight passed for bucket "${bucket}".`);
  await assertCorsPreflight({ endpoint, bucket, origin, method: "PUT", requestHeaders: corsHeadersForUpload });
  await assertCorsPreflight({ endpoint, bucket, origin, method: "GET" });
  console.log(`R2 CORS preflight passed for origin ${origin} with PUT/GET and upload headers.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
