import type { Bindings } from "../types";

type SfuRoute = {
  method: "POST" | "PUT";
};

const sfuRoutes: Array<{
  pattern: RegExp;
  method: SfuRoute["method"];
}> = [
  { pattern: /^\/sessions\/new$/, method: "POST" },
  {
    pattern: /^\/sessions\/[A-Za-z0-9_-]+\/datachannels\/establish$/,
    method: "POST",
  },
  {
    pattern: /^\/sessions\/[A-Za-z0-9_-]+\/renegotiate$/,
    method: "PUT",
  },
  {
    pattern: /^\/sessions\/[A-Za-z0-9_-]+\/datachannels\/new$/,
    method: "POST",
  },
];

export function matchSfuRoute(path: string, method: string): SfuRoute | null {
  const route = sfuRoutes.find((candidate) => candidate.method === method && candidate.pattern.test(path));
  return route ? { method: route.method } : null;
}

export async function proxySfuRequest(env: Bindings, path: string, method: SfuRoute["method"], body: string) {
  return fetch(
    `https://rtc.live.cloudflare.com/v1/apps/${encodeURIComponent(env.SFU_APP_ID)}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${env.SFU_APP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body || undefined,
    },
  );
}
