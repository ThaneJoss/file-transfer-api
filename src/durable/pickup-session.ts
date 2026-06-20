import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../types";

export type PickupVariant = "direct" | "stun";

type PickupRecord = {
  sender_user_id: string;
  variant: PickupVariant;
  offer: string;
  answer: string | null;
  receiver_user_id: string | null;
  expires_at: number;
};

type LookupResult =
  | { status: "found"; variant: PickupVariant; offer: string; expiresAt: number; answered: boolean }
  | { status: "missing" | "expired" };

type AnswerResult =
  | { status: "found"; answer: string | null }
  | { status: "missing" | "expired" | "forbidden" };

type SubmitResult = { status: "ok" | "missing" | "expired" | "answered" };

export class PickupSession extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS pickup_session (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          sender_user_id TEXT NOT NULL,
          variant TEXT NOT NULL,
          offer TEXT NOT NULL,
          answer TEXT,
          receiver_user_id TEXT,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  async reserve(input: {
    senderUserId: string;
    variant: PickupVariant;
    offer: string;
    expiresAt: number;
  }): Promise<boolean> {
    const now = Date.now();
    const current = this.readRecord();
    if (current && current.expires_at > now) return false;

    this.ctx.storage.sql.exec("DELETE FROM pickup_session");
    this.ctx.storage.sql.exec(
      `INSERT INTO pickup_session
         (singleton, sender_user_id, variant, offer, answer, receiver_user_id, expires_at, created_at)
       VALUES (1, ?, ?, ?, NULL, NULL, ?, ?)`,
      input.senderUserId,
      input.variant,
      input.offer,
      input.expiresAt,
      now,
    );
    await this.ctx.storage.setAlarm(input.expiresAt);
    return true;
  }

  async getOffer(): Promise<LookupResult> {
    const record = this.readActiveRecord();
    if (!record) return this.readRecord() ? { status: "expired" } : { status: "missing" };
    return {
      status: "found",
      variant: record.variant,
      offer: record.offer,
      expiresAt: record.expires_at,
      answered: record.answer !== null,
    };
  }

  async submitAnswer(receiverUserId: string, answer: string): Promise<SubmitResult> {
    const record = this.readActiveRecord();
    if (!record) return this.readRecord() ? { status: "expired" } : { status: "missing" };
    if (record.answer !== null) return { status: "answered" };

    this.ctx.storage.sql.exec(
      "UPDATE pickup_session SET answer = ?, receiver_user_id = ? WHERE singleton = 1",
      answer,
      receiverUserId,
    );
    return { status: "ok" };
  }

  async getAnswer(senderUserId: string): Promise<AnswerResult> {
    const record = this.readActiveRecord();
    if (!record) return this.readRecord() ? { status: "expired" } : { status: "missing" };
    if (record.sender_user_id !== senderUserId) return { status: "forbidden" };
    return { status: "found", answer: record.answer };
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM pickup_session WHERE expires_at <= ?", Date.now());
  }

  private readRecord() {
    return this.ctx.storage.sql.exec<PickupRecord>("SELECT * FROM pickup_session WHERE singleton = 1").toArray()[0];
  }

  private readActiveRecord() {
    const record = this.readRecord();
    return record && record.expires_at > Date.now() ? record : undefined;
  }
}
