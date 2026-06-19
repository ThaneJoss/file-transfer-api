import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resolveWebAuthnRelyingParty } from "../src/auth";
import type { Bindings } from "../src/types";
import { registrationContextTtlMs, resolveRegistrationContext } from "../src/passkey-registration";

const { default: app } = await import("../src/index");

const apiOrigin = "https://api.file.thanejoss.com";
const appOrigin = "https://file.thanejoss.com";

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
  return app.fetch(
    new Request(`${apiOrigin}${path}`, { ...init, headers }),
    env as unknown as Bindings,
  );
}

async function issueContext(name = "Alice") {
  const response = await request("/v1/passkey/registration-context", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ context: string }>()).context;
}

describe("passkey-only authentication", () => {
  it("derives the RP ID from the frontend origin", () => {
    expect(resolveWebAuthnRelyingParty("https://file.thanejoss.com")).toEqual({
      origin: "https://file.thanejoss.com",
      rpID: "file.thanejoss.com",
    });
    expect(resolveWebAuthnRelyingParty("http://localhost:5173")).toEqual({
      origin: "http://localhost:5173",
      rpID: "localhost",
    });
  });

  it("validates registration-context input", async () => {
    for (const body of [{}, { name: "" }, { name: "Alice", email: "a@example.com" }, { name: 7 }]) {
      const response = await request("/v1/passkey/registration-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }

    const disallowedOrigin = await app.fetch(
      new Request(`${apiOrigin}/v1/passkey/registration-context`, {
        method: "POST",
        headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      }),
      env as unknown as Bindings,
    );
    expect(disallowedOrigin.status).toBe(403);
  });

  it("rejects tampered and expired registration contexts", async () => {
    const context = await issueContext("Context Security");
    const tokenParts = context.split(".");
    tokenParts[2] = `${tokenParts[2][0] === "A" ? "B" : "A"}${tokenParts[2].slice(1)}`;
    const tampered = tokenParts.join(".");
    const tamperedResponse = await request(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(tampered)}`,
    );
    expect(tamperedResponse.status).toBe(400);

    await expect(
      resolveRegistrationContext(
        (env as unknown as Bindings).DB,
        (env as unknown as Bindings).BETTER_AUTH_SECRET,
        context,
        Date.now() + registrationContextTtlMs + 1,
      ),
    ).rejects.toThrow("Invalid, expired, or already used registration context");
  });

  it("registers and signs in with a passkey, creates sessions, and prevents context replay", async () => {
    const context = await issueContext("Alice Passkey");
    const registrationCookies: CookieJar = new Map();

    const optionsResponse = await request(
      `/api/auth/passkey/generate-register-options?name=${encodeURIComponent("Alice Passkey")}&context=${encodeURIComponent(context)}`,
      {},
      registrationCookies,
    );
    expect(optionsResponse.status).toBe(200);
    const options = await optionsResponse.json<{ rp: { id: string }; user: { displayName: string } }>();
    expect(options.rp.id).toBe("file.thanejoss.com");
    expect(options.user.displayName).toBe("Alice Passkey");
    updateCookies(optionsResponse, registrationCookies);

    const registrationResponse = await request(
      "/api/auth/passkey/verify-registration",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: { id: "credential-id", response: { transports: ["internal"] } },
          name: "Alice Passkey",
        }),
      },
      registrationCookies,
    );
    expect(registrationResponse.status).toBe(200);
    updateCookies(registrationResponse, registrationCookies);
    expect(Array.from(registrationCookies.keys()).some((name) => name.includes("session_token"))).toBe(true);

    const meAfterRegistration = await request("/v1/me", {}, registrationCookies);
    expect(meAfterRegistration.status).toBe(200);
    const registeredSession = await meAfterRegistration.json<{ user: { name: string; email: string } }>();
    expect(registeredSession.user.name).toBe("Alice Passkey");
    expect(registeredSession.user.name).not.toBe(registeredSession.user.email);

    const replayResponse = await request(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`,
    );
    expect(replayResponse.status).toBe(400);

    const loginCookies: CookieJar = new Map();
    const authenticationOptions = await request(
      "/api/auth/passkey/generate-authenticate-options",
      {},
      loginCookies,
    );
    expect(authenticationOptions.status).toBe(200);
    updateCookies(authenticationOptions, loginCookies);

    const loginResponse = await request(
      "/api/auth/passkey/verify-authentication",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: {
            id: "credential-id",
            rawId: "credential-id",
            response: {
              clientDataJSON: "test",
              authenticatorData: "test",
              signature: "test",
              userHandle: null,
            },
            type: "public-key",
          },
        }),
      },
      loginCookies,
    );
    expect(loginResponse.status).toBe(200);
    updateCookies(loginResponse, loginCookies);
    expect(Array.from(loginCookies.keys()).some((name) => name.includes("session_token"))).toBe(true);
    expect((await request("/v1/me", {}, loginCookies)).status).toBe(200);
  });

  it("does not expose email/password auth and keeps protected v1 routes private", async () => {
    const unauthenticated = await request("/v1/me");
    expect(unauthenticated.status).toBe(401);

    for (const path of ["/api/auth/sign-up/email", "/api/auth/sign-in/email"]) {
      const response = await request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Password User",
          email: "password@example.com",
          password: "password123",
        }),
      });
      expect(response.status).toBe(400);
      const error = await response.json<{ code: string }>();
      expect(error.code).toMatch(/^EMAIL_PASSWORD(?:_SIGN_UP)?_DISABLED$/u);
    }
  });
});
