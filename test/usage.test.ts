import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/types";
import {
  getCurrentMonthlyUsagePeriod,
  recordUsage,
  type UsageSummaryResponse,
} from "../src/usage";

const { default: app } = await import("../src/index");

const apiOrigin = "https://api.file.thanejoss.com";
const appOrigin = "https://file.thanejoss.com";
const bindings = env as unknown as Bindings;

type CookieJar = Map<string, string>;

function updateCookies(response: Response, jar: CookieJar) {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";", 1);
    const separator = pair.indexOf("=");
    if (separator > 0) {
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

async function request(path: string, init: RequestInit = {}, jar?: CookieJar) {
  const headers = new Headers(init.headers);
  headers.set("Origin", appOrigin);
  if (jar?.size) {
    headers.set(
      "Cookie",
      Array.from(jar, ([name, value]) => `${name}=${value}`).join("; "),
    );
  }
  return app.fetch(new Request(`${apiOrigin}${path}`, { ...init, headers }), bindings);
}

async function registerUser(label: string) {
  const name = `${label} ${crypto.randomUUID()}`;
  const contextResponse = await request("/v1/passkey/registration-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(contextResponse.status).toBe(201);
  const { context } = await contextResponse.json<{ context: string }>();

  const jar: CookieJar = new Map();
  const optionsResponse = await request(
    `/api/auth/passkey/generate-register-options?name=${encodeURIComponent(name)}&context=${encodeURIComponent(context)}`,
    {},
    jar,
  );
  expect(optionsResponse.status).toBe(200);
  updateCookies(optionsResponse, jar);

  const registrationResponse = await request(
    "/api/auth/passkey/verify-registration",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response: {
          id: `usage-${crypto.randomUUID()}`,
          response: { transports: ["internal"] },
        },
        name,
      }),
    },
    jar,
  );
  expect(registrationResponse.status).toBe(200);
  updateCookies(registrationResponse, jar);

  const meResponse = await request("/v1/me", {}, jar);
  expect(meResponse.status).toBe(200);
  const me = await meResponse.json<{ user: { id: string } }>();

  return { jar, userId: me.user.id };
}

function byService(response: UsageSummaryResponse) {
  return new Map(response.summary.map((item) => [item.service, item]));
}

function decodeBase64UrlJson<T>(value: string): T {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return JSON.parse(atob(base64)) as T;
}

describe("usage API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 when the user is not authenticated", async () => {
    const response = await request("/v1/usage");

    expect(response.status).toBe(401);
  });

  it("returns all services with zero bytes when the user has no usage", async () => {
    const { jar } = await registerUser("No Usage");
    const beforeRequest = new Date();
    const response = await request("/v1/usage", {}, jar);
    const afterRequest = new Date();

    expect(response.status).toBe(200);
    const body = await response.json<UsageSummaryResponse>();
    const expectedStart = getCurrentMonthlyUsagePeriod(beforeRequest).start.toISOString();

    expect(body.period.start).toBe(expectedStart);
    expect(body.period.timezone).toBe("UTC");
    expect(Date.parse(body.period.end)).toBeGreaterThanOrEqual(beforeRequest.getTime());
    expect(Date.parse(body.period.end)).toBeLessThanOrEqual(afterRequest.getTime());
    expect(body.summary.map((item) => item.service)).toEqual([
      "direct",
      "stun",
      "turn",
      "sfu",
      "r2",
      "durable",
    ]);
    expect(body.summary.every((item) => item.bytes === 0 && item.quotaBytes === null)).toBe(true);
    expect(body.summary.find((item) => item.service === "durable")).toMatchObject({
      unit: "requests",
      usage: 0,
      quota: null,
    });
    expect(body.totals).toEqual({ bytes: 0, requests: 0 });
    expect(body.totalBytes).toBe(0);
    expect(body.totalQuotaBytes).toBeNull();
  });

  it("returns only the current user's current-month TURN/SFU/R2 bytes", async () => {
    const owner = await registerUser("Usage Owner");
    const other = await registerUser("Usage Other");
    const period = getCurrentMonthlyUsagePeriod();
    const beforeMonthStart = new Date(period.start.getTime() - 1000);
    const insideMonth = new Date();

    await recordUsage(bindings, {
      userId: owner.userId,
      service: "turn",
      quantity: 100,
      createdAt: period.start,
    });
    await recordUsage(bindings, {
      userId: owner.userId,
      service: "sfu",
      quantity: 200,
      createdAt: insideMonth,
    });
    await recordUsage(bindings, {
      userId: owner.userId,
      service: "r2",
      quantity: 300,
      createdAt: insideMonth,
    });
    await recordUsage(bindings, {
      userId: owner.userId,
      service: "r2",
      quantity: 999,
      createdAt: beforeMonthStart,
    });
    await recordUsage(bindings, {
      userId: other.userId,
      service: "turn",
      quantity: 500,
      createdAt: insideMonth,
    });

    const response = await request("/v1/usage", {}, owner.jar);

    expect(response.status).toBe(200);
    const body = await response.json<UsageSummaryResponse>();
    const summary = byService(body);

    expect(summary.get("turn")?.bytes).toBe(100);
    expect(summary.get("sfu")?.bytes).toBe(200);
    expect(summary.get("r2")?.bytes).toBe(300);
    expect(body.totalBytes).toBe(600);
    expect(body.period.start).toBe(period.start.toISOString());
    expect(body.period.timezone).toBe("UTC");
  });

  it("does not record declared TURN bytes when credentials are issued", async () => {
    const owner = await registerUser("TURN Usage Owner");
    const turnFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe(
        "https://rtc.live.cloudflare.com/v1/turn/keys/test/credentials/generate-ice-servers",
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      });
      expect(init?.body).toBe(JSON.stringify({ ttl: 3600 }));

      return new Response(
        JSON.stringify({
          iceServers: [
            {
              urls: "turn:example.com:3478?transport=udp",
              username: "temporary-user",
              credential: "temporary-password",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const credentialsResponse = await request(
      "/v1/turn/credentials",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 3600, fileSizeBytes: 1234 }),
      },
      owner.jar,
    );

    expect(credentialsResponse.status).toBe(201);
    expect(turnFetch).toHaveBeenCalledTimes(1);

    const usageResponse = await request("/v1/usage", {}, owner.jar);
    expect(usageResponse.status).toBe(200);
    const body = await usageResponse.json<UsageSummaryResponse>();
    const summary = byService(body);

    expect(summary.get("turn")?.bytes).toBe(0);
    expect(summary.get("sfu")?.bytes).toBe(0);
    expect(summary.get("r2")?.bytes).toBe(0);
    expect(body.totalBytes).toBe(0);
  });

  it("does not record declared R2 bytes when locally signed credentials are issued", async () => {
    const owner = await registerUser("R2 Usage Owner");

    const credentialsResponse = await request(
      "/v1/r2/credentials",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: "example.bin", ttlSeconds: 900, fileSizeBytes: 2345 }),
      },
      owner.jar,
    );

    expect(credentialsResponse.status).toBe(201);
    const credentials = await credentialsResponse.json<{
      accountId: string;
      bucket: string;
      endpoint: string;
      objectKey: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
      expiresAt: string;
    }>();

    expect(credentials).toMatchObject({
      accountId: "test",
      bucket: "test",
      endpoint: "https://test.r2.cloudflarestorage.com",
      accessKeyId: "test",
    });
    expect(credentials.objectKey).toMatch(/\/[0-9a-f-]+-example\.bin$/u);
    expect(credentials.secretAccessKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(Date.parse(credentials.expiresAt)).toBeGreaterThan(Date.now());

    const jwt = atob(credentials.sessionToken).replace(/^jwt\//u, "");
    const [, payload] = jwt.split(".");
    const claims = decodeBase64UrlJson<{
      bucket: string;
      scope: string;
      paths: { objectPaths: string[] };
      sub: string;
      iss: string;
      aud: string;
      iat: number;
      exp: number;
    }>(payload);

    expect(claims).toMatchObject({
      bucket: "test",
      scope: "object-read-write",
      paths: { objectPaths: [credentials.objectKey] },
      sub: "test",
      iss: "test",
      aud: "test.r2.cloudflarestorage.com",
    });
    expect(claims.exp - claims.iat).toBe(900);

    const usageResponse = await request("/v1/usage", {}, owner.jar);
    expect(usageResponse.status).toBe(200);
    const body = await usageResponse.json<UsageSummaryResponse>();
    const summary = byService(body);

    expect(summary.get("r2")?.bytes).toBe(0);
    expect(body.totalBytes).toBe(0);
  });

  it("reissues temporary credentials for an owned multipart resume key only", async () => {
    const owner = await registerUser("R2 Resume Owner");
    const outsider = await registerUser("R2 Resume Outsider");
    const first = await request(
      "/v1/r2/credentials",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: "resume.bin", ttlSeconds: 900, fileSizeBytes: 8_000_000 }),
      },
      owner.jar,
    ).then((response) => response.json<{ objectKey: string }>());

    const resumed = await request(
      "/v1/r2/credentials",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "resume.bin",
          ttlSeconds: 900,
          fileSizeBytes: 8_000_000,
          objectKey: first.objectKey,
        }),
      },
      owner.jar,
    );
    expect(resumed.status).toBe(201);
    expect(await resumed.json<{ objectKey: string }>()).toMatchObject({ objectKey: first.objectKey });

    const stolen = await request(
      "/v1/r2/credentials",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: "resume.bin", objectKey: first.objectKey }),
      },
      outsider.jar,
    );
    expect(stolen.status).toBe(403);
  });
});
