import type { Bindings } from "../types";

type TurnResponse = {
  iceServers?: unknown[];
  errors?: Array<{ message?: string }>;
};

export async function issueTurnCredentials(env: Bindings, ttlSeconds: number) {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: ttlSeconds }),
    },
  );
  const data = (await response.json().catch(() => ({}))) as TurnResponse;

  if (!response.ok || !Array.isArray(data.iceServers)) {
    const details = data.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(details || `TURN API returned HTTP ${response.status}`);
  }

  return {
    iceServers: data.iceServers,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}
