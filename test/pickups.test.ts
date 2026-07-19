import { describe, expect, it, vi } from "vitest";
import { consumeGuestClaimRateLimit } from "../src/guest";
import type { UsageSummaryResponse } from "../src/usage";
import { bindings, registerUser, request } from "./support";

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

  it("reserves a code before the offer is ready and lets only the sender publish it once", async () => {
    const sender = await registerUser("Deferred Offer Sender");
    const receiver = await registerUser("Deferred Offer Receiver");
    const outsider = await registerUser("Deferred Offer Outsider");
    const createResponse = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath" }),
      },
      sender.jar,
    );
    expect(createResponse.status).toBe(201);
    const pickup = await createResponse.json<{ code: string; expiresAt: number }>();

    const pendingResponse = await request(`/v1/pickups/${pickup.code}`, {}, receiver.jar);
    expect(pendingResponse.status).toBe(202);
    expect(await pendingResponse.json()).toEqual({
      status: "pending",
      variant: "multipath",
      expiresAt: pickup.expiresAt,
    });

    const earlyAnswer = await request(
      `/v1/pickups/${pickup.code}/answer`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "too-early" }),
      },
      receiver.jar,
    );
    expect(earlyAnswer.status).toBe(409);
    expect(await earlyAnswer.json()).toEqual({ error: "Pickup offer is not ready yet" });

    const outsiderPublish = await request(
      `/v1/pickups/${pickup.code}/offer`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer: "hijacked-offer" }),
      },
      outsider.jar,
    );
    expect(outsiderPublish.status).toBe(403);

    const publish = (offer: string) => request(
      `/v1/pickups/${pickup.code}/offer`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer }),
      },
      sender.jar,
    );
    const waitingOffer = request(`/v1/pickups/${pickup.code}?wait=5000`, {}, receiver.jar);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const publishResponse = await publish("deferred-offer");
    expect(publishResponse.status).toBe(200);
    expect(await publishResponse.json()).toEqual({ accepted: true });
    const waitingOfferResponse = await waitingOffer;
    expect(waitingOfferResponse.status).toBe(200);
    expect(await waitingOfferResponse.json()).toMatchObject({ status: "found", offer: "deferred-offer" });

    const idempotentPublish = await publish("deferred-offer");
    expect(idempotentPublish.status).toBe(200);
    const conflictingPublish = await publish("different-offer");
    expect(conflictingPublish.status).toBe(409);
    expect(await conflictingPublish.json()).toEqual({ error: "Pickup offer was already published" });

    const readyResponse = await request(`/v1/pickups/${pickup.code}`, {}, receiver.jar);
    expect(readyResponse.status).toBe(200);
    expect(await readyResponse.json()).toMatchObject({
      status: "found",
      variant: "multipath",
      offer: "deferred-offer",
      answered: false,
    });
  });

  it("accepts every transfer method as a pickup variant", async () => {
    const sender = await registerUser("Pickup Variant Sender");
    const receiver = await registerUser("Pickup Variant Receiver");

    for (const variant of ["turn", "sfu", "r2", "multipath"] as const) {
      const createResponse = await request(
        "/v1/pickups",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variant, offer: `${variant}-offer` }),
        },
        sender.jar,
      );
      expect(createResponse.status).toBe(201);
      const pickup = await createResponse.json<{ code: string }>();

      const offerResponse = await request(`/v1/pickups/${pickup.code}`, {}, receiver.jar);
      expect(offerResponse.status).toBe(200);
      expect(await offerResponse.json()).toMatchObject({
        status: "found",
        variant,
        offer: `${variant}-offer`,
      });
    }
  });

  it("accepts 384 KiB pickup signals and rejects bodies above the coordinated limit", async () => {
    const sender = await registerUser("Large Pickup Sender");
    const receiver = await registerUser("Large Pickup Receiver");
    const offer = "o".repeat(384 * 1024);
    const answer = "a".repeat(384 * 1024);

    const createResponse = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath", offer }),
      },
      sender.jar,
    );
    expect(createResponse.status).toBe(201);
    const pickup = await createResponse.json<{ code: string }>();

    const offerResponse = await request(`/v1/pickups/${pickup.code}`, {}, receiver.jar);
    expect(offerResponse.status).toBe(200);
    expect((await offerResponse.json<{ offer: string }>()).offer).toBe(offer);

    const answerResponse = await request(
      `/v1/pickups/${pickup.code}/answer`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      },
      receiver.jar,
    );
    expect(answerResponse.status).toBe(200);

    const oversizedSignalResponse = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath", offer: "x".repeat(384 * 1024 + 1) }),
      },
      sender.jar,
    );
    expect(oversizedSignalResponse.status).toBe(400);
    expect(await oversizedSignalResponse.json()).toEqual({ error: "offer must be 1 to 393216 UTF-8 bytes" });

    const oversizedResponse = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath", offer: "x".repeat(385 * 1024) }),
      },
      sender.jar,
    );
    expect(oversizedResponse.status).toBe(413);
    expect(await oversizedResponse.json()).toEqual({ error: "Request body too large" });
  });

  it("coordinates sender selection updates and a receiver winner exactly once", async () => {
    const sender = await registerUser("Multipath Sender");
    const receiver = await registerUser("Multipath Receiver");
    const createResponse = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath", offer: "multipath-offer" }),
      },
      sender.jar,
    );
    const pickup = await createResponse.json<{ code: string }>();

    const emptyWinner = await request(`/v1/pickups/${pickup.code}/winner`, {}, sender.jar);
    expect(emptyWinner.status).toBe(404);
    expect(await emptyWinner.json()).toEqual({ error: "Pickup winner not confirmed yet" });

    const answerResponse = await request(
      `/v1/pickups/${pickup.code}/answer`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "multipath-answer" }),
      },
      receiver.jar,
    );
    expect(answerResponse.status).toBe(200);

    const emptySelection = await request(`/v1/pickups/${pickup.code}/selection`, {}, receiver.jar);
    expect(emptySelection.status).toBe(404);
    expect(await emptySelection.json()).toEqual({ error: "Pickup route not selected yet" });

    const selectionResponse = await request(
      `/v1/pickups/${pickup.code}/selection`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "stun" }),
      },
      sender.jar,
    );
    expect(selectionResponse.status).toBe(200);
    expect(await selectionResponse.json()).toEqual({ accepted: true });

    const repeatedSelection = await request(
      `/v1/pickups/${pickup.code}/selection`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "stun" }),
      },
      sender.jar,
    );
    expect(repeatedSelection.status).toBe(200);
    expect(await repeatedSelection.json()).toEqual({ accepted: true });

    const updatedSelection = await request(
      `/v1/pickups/${pickup.code}/selection`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "r2" }),
      },
      sender.jar,
    );
    expect(updatedSelection.status).toBe(200);
    expect(await updatedSelection.json()).toEqual({ accepted: true });

    const readSelection = await request(`/v1/pickups/${pickup.code}/selection`, {}, receiver.jar);
    expect(await readSelection.json()).toEqual({ route: "r2" });

    const winnerCandidates = [
      { route: "stun", bytes: 12_345, sha256: "AB".repeat(32) },
      { route: "r2", bytes: 1, sha256: "cd".repeat(32) },
    ] as const;
    const winnerResponses = await Promise.all(
      winnerCandidates.map((winner) =>
        request(
          `/v1/pickups/${pickup.code}/winner`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(winner),
          },
          receiver.jar,
        ),
      ),
    );
    expect(winnerResponses.map((response) => response.status).sort()).toEqual([200, 409]);
    const acceptedWinner = winnerCandidates[winnerResponses.findIndex((response) => response.status === 200)];
    expect(acceptedWinner).toBeDefined();
    if (!acceptedWinner) throw new Error("Expected one winner request to be accepted");

    const readWinner = await request(`/v1/pickups/${pickup.code}/winner`, {}, sender.jar);
    expect(readWinner.status).toBe(200);
    expect(await readWinner.json()).toEqual({
      ...acceptedWinner,
      sha256: acceptedWinner.sha256.toLowerCase(),
    });

    const repeatedWinner = await request(
      `/v1/pickups/${pickup.code}/winner`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(acceptedWinner),
      },
      receiver.jar,
    );
    expect(repeatedWinner.status).toBe(200);
    expect(await repeatedWinner.json()).toEqual({ accepted: true });

    const selectionAfterWinner = await request(
      `/v1/pickups/${pickup.code}/selection`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "turn" }),
      },
      sender.jar,
    );
    expect(selectionAfterWinner.status).toBe(409);
    expect(await selectionAfterWinner.json()).toEqual({ error: "Pickup code already has a winning route" });

    const cancelAfterWinner = await request(
      `/v1/pickups/${pickup.code}/cancel`,
      { method: "PUT" },
      receiver.jar,
    );
    expect(cancelAfterWinner.status).toBe(409);
    expect(await cancelAfterWinner.json()).toEqual({ error: "Pickup code already has a winning route" });
  });

  it("restricts coordination to the sender and the receiver bound by answer", async () => {
    const sender = await registerUser("Coordination Sender");
    const receiver = await registerUser("Coordination Receiver");
    const outsider = await registerUser("Coordination Outsider");
    const createResponse = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath", offer: "offer" }),
      },
      sender.jar,
    );
    const pickup = await createResponse.json<{ code: string }>();

    const unboundSelection = await request(`/v1/pickups/${pickup.code}/selection`, {}, outsider.jar);
    expect(unboundSelection.status).toBe(403);
    const unboundWinner = await request(
      `/v1/pickups/${pickup.code}/winner`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "direct", bytes: 0, sha256: "00".repeat(32) }),
      },
      outsider.jar,
    );
    expect(unboundWinner.status).toBe(403);

    const bindReceiver = await request(
      `/v1/pickups/${pickup.code}/answer`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "answer" }),
      },
      receiver.jar,
    );
    expect(bindReceiver.status).toBe(200);

    const receiverSelectionWrite = await request(
      `/v1/pickups/${pickup.code}/selection`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "direct" }),
      },
      receiver.jar,
    );
    expect(receiverSelectionWrite.status).toBe(403);
    const senderSelectionRead = await request(`/v1/pickups/${pickup.code}/selection`, {}, sender.jar);
    expect(senderSelectionRead.status).toBe(403);
    const receiverWinnerRead = await request(`/v1/pickups/${pickup.code}/winner`, {}, receiver.jar);
    expect(receiverWinnerRead.status).toBe(403);
    const senderWinnerWrite = await request(
      `/v1/pickups/${pickup.code}/winner`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "direct", bytes: 0, sha256: "00".repeat(32) }),
      },
      sender.jar,
    );
    expect(senderWinnerWrite.status).toBe(403);
    const outsiderSelectionRead = await request(`/v1/pickups/${pickup.code}/selection`, {}, outsider.jar);
    expect(outsiderSelectionRead.status).toBe(403);

    const invalidSelection = await request(
      `/v1/pickups/${pickup.code}/selection`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "multipath" }),
      },
      sender.jar,
    );
    expect(invalidSelection.status).toBe(400);
    const invalidWinner = await request(
      `/v1/pickups/${pickup.code}/winner`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "direct", bytes: -1, sha256: "00".repeat(32) }),
      },
      receiver.jar,
    );
    expect(invalidWinner.status).toBe(400);
  });

  it("lets either transfer side cancel and exposes cancellation to both sides", async () => {
    const sender = await registerUser("Cancellation Sender");
    const receiver = await registerUser("Cancellation Receiver");
    const outsider = await registerUser("Cancellation Outsider");
    const createResponse = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath", offer: "cancel-offer" }),
      },
      sender.jar,
    );
    const pickup = await createResponse.json<{ code: string; expiresAt: number }>();

    const senderStatus = await request(`/v1/pickups/${pickup.code}/status`, {}, sender.jar);
    expect(senderStatus.status).toBe(200);
    expect(await senderStatus.json()).toEqual({ cancelled: false, expiresAt: pickup.expiresAt });

    const unboundStatus = await request(`/v1/pickups/${pickup.code}/status`, {}, outsider.jar);
    expect(unboundStatus.status).toBe(403);
    const outsiderCancel = await request(
      `/v1/pickups/${pickup.code}/cancel`,
      { method: "PUT" },
      outsider.jar,
    );
    expect(outsiderCancel.status).toBe(403);

    const answerResponse = await request(
      `/v1/pickups/${pickup.code}/answer`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "cancel-answer" }),
      },
      receiver.jar,
    );
    expect(answerResponse.status).toBe(200);
    const receiverStatus = await request(`/v1/pickups/${pickup.code}/status`, {}, receiver.jar);
    expect(receiverStatus.status).toBe(200);
    expect(await receiverStatus.json()).toEqual({ cancelled: false, expiresAt: pickup.expiresAt });

    const receiverCancel = await request(
      `/v1/pickups/${pickup.code}/cancel`,
      { method: "PUT" },
      receiver.jar,
    );
    expect(receiverCancel.status).toBe(200);
    expect(await receiverCancel.json()).toEqual({ cancelled: true });
    const repeatedCancel = await request(
      `/v1/pickups/${pickup.code}/cancel`,
      { method: "PUT" },
      sender.jar,
    );
    expect(repeatedCancel.status).toBe(200);
    expect(await repeatedCancel.json()).toEqual({ cancelled: true });

    for (const [jar, expectedStatus] of [
      [sender.jar, 200],
      [receiver.jar, 200],
      [outsider.jar, 403],
    ] as const) {
      const statusResponse = await request(`/v1/pickups/${pickup.code}/status`, {}, jar);
      expect(statusResponse.status).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(await statusResponse.json()).toEqual({ cancelled: true, expiresAt: pickup.expiresAt });
      }
    }

    const cancelledRequests = await Promise.all([
      request(`/v1/pickups/${pickup.code}`, {}, receiver.jar),
      request(`/v1/pickups/${pickup.code}/answer`, {}, sender.jar),
      request(
        `/v1/pickups/${pickup.code}/answer`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: "replacement-answer" }),
        },
        outsider.jar,
      ),
      request(`/v1/pickups/${pickup.code}/selection`, {}, receiver.jar),
      request(
        `/v1/pickups/${pickup.code}/selection`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ route: "direct" }),
        },
        sender.jar,
      ),
      request(`/v1/pickups/${pickup.code}/winner`, {}, sender.jar),
      request(
        `/v1/pickups/${pickup.code}/winner`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ route: "direct", bytes: 0, sha256: "00".repeat(32) }),
        },
        receiver.jar,
      ),
    ]);
    expect(cancelledRequests.map((response) => response.status)).toEqual([410, 410, 410, 410, 410, 410, 410]);
    for (const response of cancelledRequests) {
      expect(await response.json()).toEqual({ error: "Pickup transfer was cancelled" });
    }
  });

  it("records all five verified transfer services independently and idempotently", async () => {
    const user = await registerUser("Transfer Usage");
    const transferId = crypto.randomUUID();
    const services = ["direct", "stun", "turn", "sfu", "r2"] as const;

    for (const [index, service] of services.entries()) {
      const body = JSON.stringify({ service, bytes: 10_000 + index, transferId });
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
      expect(await first.json()).toEqual({ recorded: true });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ recorded: false });
    }

    const usageResponse = await request("/v1/usage", {}, user.jar);
    const usage = await usageResponse.json<UsageSummaryResponse>();
    for (const [index, service] of services.entries()) {
      expect(usage.summary.find((item) => item.service === service)?.usage).toBe(10_000 + index);
    }

    const events = await bindings.DB.prepare(
      "SELECT service, idempotency_key, metadata FROM usage_event WHERE user_id = ? AND unit = 'bytes' ORDER BY service",
    )
      .bind(user.user.id)
      .all<{ service: string; idempotency_key: string; metadata: string }>();
    expect(events.results).toHaveLength(services.length);
    for (const event of events.results) {
      expect(event.idempotency_key).toBe(`${user.user.id}:${event.service}:${transferId}`);
      expect(JSON.parse(event.metadata)).toMatchObject({ source: "verified_winner_payload", transferId });
    }
  });

  it("wakes long-polling answer, selection, winner and cancellation reads on state changes", async () => {
    const sender = await registerUser("Long Poll Sender");
    const receiver = await registerUser("Long Poll Receiver");
    const created = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath", offer: "long-poll-offer" }),
      },
      sender.jar,
    );
    const pickup = await created.json<{ code: string }>();

    const waitingAnswer = request(`/v1/pickups/${pickup.code}/answer?wait=5000`, {}, sender.jar);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await request(
      `/v1/pickups/${pickup.code}/answer`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "ready" }) },
      receiver.jar,
    );
    expect(await (await waitingAnswer).json()).toEqual({ answer: "ready" });

    const waitingSelection = request(`/v1/pickups/${pickup.code}/selection?wait=5000`, {}, receiver.jar);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await request(
      `/v1/pickups/${pickup.code}/selection`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ route: "direct" }) },
      sender.jar,
    );
    expect(await (await waitingSelection).json()).toEqual({ route: "direct" });

    const waitingWinner = request(`/v1/pickups/${pickup.code}/winner?wait=5000`, {}, sender.jar);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const winner = { route: "direct", bytes: 5, sha256: "ab".repeat(32) };
    await request(
      `/v1/pickups/${pickup.code}/winner`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(winner) },
      receiver.jar,
    );
    expect(await (await waitingWinner).json()).toEqual(winner);

    const another = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath", offer: "cancel-offer" }),
      },
      sender.jar,
    ).then((response) => response.json<{ code: string }>());
    await request(
      `/v1/pickups/${another.code}/answer`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "bound" }) },
      receiver.jar,
    );
    const waitingStatus = request(`/v1/pickups/${another.code}/status?wait=5000`, {}, receiver.jar);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await request(`/v1/pickups/${another.code}/cancel`, { method: "PUT" }, sender.jar);
    expect(await (await waitingStatus).json()).toMatchObject({ cancelled: true });
  });

  it("lets a rate-limited guest receiver finish one pickup without gaining sender privileges", async () => {
    const sender = await registerUser("Guest Sender");
    const created = await request(
      "/v1/pickups",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant: "multipath", offer: "guest-offer" }),
      },
      sender.jar,
    );
    const pickup = await created.json<{ code: string }>();
    const claimResponse = await request(`/v1/pickups/${pickup.code}/guest`, { method: "POST" });
    expect(claimResponse.status).toBe(201);
    const claim = await claimResponse.json<{ token: string; expiresAt: number; pickup: { offer: string } }>();
    expect(claim.pickup.offer).toBe("guest-offer");
    const guestHeaders = { "X-Pickup-Guest-Token": claim.token };

    let issuedTurnTtl = 0;
    const turnFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      issuedTurnTtl = (JSON.parse(String(init?.body)) as { ttl: number }).ttl;
      return new Response(JSON.stringify({ iceServers: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    try {
      const turnCredentials = await request("/v1/turn/credentials", {
        method: "POST",
        headers: { ...guestHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: 86_400 }),
      });
      expect(turnCredentials.status).toBe(201);
      expect(issuedTurnTtl).toBeGreaterThanOrEqual(60);
      expect(issuedTurnTtl).toBeLessThanOrEqual(3_600);
      const issuedTurnExpiry = Date.parse((await turnCredentials.json<{ expiresAt: string }>()).expiresAt);
      expect(issuedTurnExpiry).toBeLessThanOrEqual(claim.expiresAt);
    } finally {
      turnFetch.mockRestore();
    }

    const offer = await request(`/v1/pickups/${pickup.code}`, { headers: guestHeaders });
    expect(offer.status).toBe(200);
    const answer = await request(`/v1/pickups/${pickup.code}/answer`, {
      method: "PUT",
      headers: { ...guestHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ answer: "guest-answer" }),
    });
    expect(answer.status).toBe(200);

    const forbiddenAnswerRead = await request(`/v1/pickups/${pickup.code}/answer`, { headers: guestHeaders });
    expect(forbiddenAnswerRead.status).toBe(401);
    const forbiddenCreate = await request("/v1/pickups", {
      method: "POST",
      headers: { ...guestHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ variant: "direct", offer: "forbidden" }),
    });
    expect(forbiddenCreate.status).toBe(401);
    const differentPickup = await request("/v1/pickups/99999999", { headers: guestHeaders });
    expect(differentPickup.status).toBe(401);

    await request(
      `/v1/pickups/${pickup.code}/selection`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ route: "r2" }) },
      sender.jar,
    );
    const selection = await request(`/v1/pickups/${pickup.code}/selection`, { headers: guestHeaders });
    expect(await selection.json()).toEqual({ route: "r2" });
    const winner = { route: "r2", bytes: 10, sha256: "cd".repeat(32) };
    const completion = await request(`/v1/pickups/${pickup.code}/winner`, {
      method: "PUT",
      headers: { ...guestHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(winner),
    });
    expect(completion.status).toBe(200);
    expect(await (await request(`/v1/pickups/${pickup.code}/winner`, {}, sender.jar)).json()).toEqual(winner);

    const diagnostics = await request("/v1/diagnostics/transfers", {
      method: "POST",
      headers: { ...guestHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: crypto.randomUUID(), side: "receiver", outcome: "complete", mode: "auto", winner: "r2",
        durationMs: 250, errorCode: null,
        capabilities: { rtc: true, fileSystem: false, worker: true },
        routes: { direct: "failed", r2: "complete" },
      }),
    });
    expect(diagnostics.status).toBe(202);

    const missing = await request("/v1/pickups/99999999/guest", { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("limits guest pickup claims without retaining raw client addresses", async () => {
    const address = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await expect(consumeGuestClaimRateLimit(bindings, address)).resolves.toMatchObject({ allowed: true });
    }
    await expect(consumeGuestClaimRateLimit(bindings, address)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
    });
    const rows = await bindings.DB.prepare(
      "SELECT client_hash FROM guest_claim_rate_limit WHERE client_hash = ?",
    ).bind(address).all();
    expect(rows.results).toHaveLength(0);
  });
});
