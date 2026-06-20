import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

describe("usage API", () => {
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
    expect(body.summary.map((item) => item.service)).toEqual(["turn", "sfu", "r2"]);
    expect(body.summary.every((item) => item.bytes === 0 && item.quotaBytes === null)).toBe(true);
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
      bytes: 100,
      createdAt: period.start,
    });
    await recordUsage(bindings, {
      userId: owner.userId,
      service: "sfu",
      bytes: 200,
      createdAt: insideMonth,
    });
    await recordUsage(bindings, {
      userId: owner.userId,
      service: "r2",
      bytes: 300,
      createdAt: insideMonth,
    });
    await recordUsage(bindings, {
      userId: owner.userId,
      service: "r2",
      bytes: 999,
      createdAt: beforeMonthStart,
    });
    await recordUsage(bindings, {
      userId: other.userId,
      service: "turn",
      bytes: 500,
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
});
