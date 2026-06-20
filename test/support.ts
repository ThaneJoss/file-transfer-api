import { env } from "cloudflare:test";
import { expect } from "vitest";
import type { Bindings } from "../src/types";

const { default: app } = await import("../src/index");

const apiOrigin = "https://api.file.thanejoss.com";
const appOrigin = "https://file.thanejoss.com";
export const bindings = env as unknown as Bindings;
export type CookieJar = Map<string, string>;

function updateCookies(response: Response, jar: CookieJar) {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";", 1);
    const separator = pair.indexOf("=");
    if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

export async function request(path: string, init: RequestInit = {}, jar?: CookieJar) {
  const headers = new Headers(init.headers);
  headers.set("Origin", appOrigin);
  if (jar?.size) {
    headers.set("Cookie", Array.from(jar, ([name, value]) => `${name}=${value}`).join("; "));
  }
  return app.fetch(new Request(`${apiOrigin}${path}`, { ...init, headers }), bindings);
}

export async function registerUser(label: string) {
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
  updateCookies(optionsResponse, jar);
  const registrationResponse = await request(
    "/api/auth/passkey/verify-registration",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response: {
          id: `test-${crypto.randomUUID()}`,
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
  const me = await meResponse.json<{ user: { id: string; name: string; email: string } }>();
  return { jar, user: me.user };
}
