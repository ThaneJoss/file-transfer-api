import { describe, expect, it } from "vitest";
import type { UsageSummaryResponse } from "../src/usage";
import { registerUser, request } from "./support";

describe("pickup code API", () => {
  it("requires a session for every pickup operation", async () => {
    const response = await request("/v1/pickups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant: "direct", offer: "offer" }),
    });
    expect(response.status).toBe(401);
  });

  it("exchanges an offer and answer through a unique 8 digit code and bills each DO request", async () => {
    const sender = await registerUser("Pickup Sender");
    const receiver = await registerUser("Pickup Receiver");
    const createResponse = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "stun", offer: "encoded-offer" }),
      },
      sender.jar,
    );
    expect(createResponse.status).toBe(201);
    const pickup = await createResponse.json<{ code: string; expiresAt: number }>();
    expect(pickup.code).toMatch(/^\d{8}$/);
    expect(pickup.expiresAt).toBeGreaterThan(Date.now());

    const secondResponse = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "direct", offer: "another-offer" }),
      },
      sender.jar,
    );
    const second = await secondResponse.json<{ code: string }>();
    expect(second.code).toMatch(/^\d{8}$/);
    expect(second.code).not.toBe(pickup.code);

    const offerResponse = await request(`/v1/pickups/${pickup.code}`, {}, receiver.jar);
    expect(offerResponse.status).toBe(200);
    expect(await offerResponse.json()).toMatchObject({
      status: "found",
      variant: "stun",
      offer: "encoded-offer",
      answered: false,
    });

    const answerResponse = await request(
      `/v1/pickups/${pickup.code}/answer`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "encoded-answer" }),
      },
      receiver.jar,
    );
    expect(answerResponse.status).toBe(200);

    const readAnswer = await request(`/v1/pickups/${pickup.code}/answer`, {}, sender.jar);
    expect(readAnswer.status).toBe(200);
    expect(await readAnswer.json()).toEqual({ answer: "encoded-answer" });

    const senderUsage = await request("/v1/usage", {}, sender.jar);
    const senderSummary = await senderUsage.json<UsageSummaryResponse>();
    expect(senderSummary.summary.find((item) => item.service === "durable")?.usage).toBe(3);
    const receiverUsage = await request("/v1/usage", {}, receiver.jar);
    const receiverSummary = await receiverUsage.json<UsageSummaryResponse>();
    expect(receiverSummary.summary.find((item) => item.service === "durable")?.usage).toBe(2);
  });

  it("records completed Direct/STUN bytes idempotently", async () => {
    const user = await registerUser("Transfer Usage");
    const body = JSON.stringify({
      service: "direct",
      bytes: 12345,
      transferId: crypto.randomUUID(),
    });
    const first = await request(
      "/v1/usage/transfers",
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      user.jar,
    );
    const retry = await request(
      "/v1/usage/transfers",
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      user.jar,
    );
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ recorded: false });

    const usageResponse = await request("/v1/usage", {}, user.jar);
    const usage = await usageResponse.json<UsageSummaryResponse>();
    expect(usage.summary.find((item) => item.service === "direct")?.usage).toBe(12345);
  });
});
