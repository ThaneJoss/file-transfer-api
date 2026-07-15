import type { Bindings } from "./types";
import type { PickupRoute, PickupVariant } from "./durable/pickup-session";

export const pickupCodePattern = /^\d{8}$/;
export const pickupLifetimeMs = 60 * 60 * 1000;
export const pickupRoutes = ["direct", "stun", "turn", "sfu", "r2"] as const satisfies readonly PickupRoute[];
export const pickupVariants = [...pickupRoutes, "multipath"] as const satisfies readonly PickupVariant[];

export function isPickupRoute(value: unknown): value is PickupRoute {
  return typeof value === "string" && pickupRoutes.includes(value as PickupRoute);
}

export function isPickupVariant(value: unknown): value is PickupVariant {
  return typeof value === "string" && pickupVariants.includes(value as PickupVariant);
}

export async function createPickup(
  env: Bindings,
  input: { senderUserId: string; variant: PickupVariant; offer?: string },
) {
  const expiresAt = Date.now() + pickupLifetimeMs;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const code = secureEightDigitCode();
    const reserved = await env.PICKUP_SESSIONS.getByName(code).reserve({
      senderUserId: input.senderUserId,
      variant: input.variant,
      offer: input.offer,
      expiresAt,
    });
    if (reserved) return { code, expiresAt };
  }
  throw new Error("Unable to allocate a unique pickup code");
}

function secureEightDigitCode() {
  const values = new Uint32Array(1);
  const max = Math.floor(0x1_0000_0000 / 100_000_000) * 100_000_000;
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= max);
  return String(values[0] % 100_000_000).padStart(8, "0");
}
