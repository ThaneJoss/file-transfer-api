import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../types";

export type PickupRoute = "direct" | "stun" | "turn" | "sfu" | "r2";
export type PickupVariant = PickupRoute | "multipath";

export type PickupWinner = {
  route: PickupRoute;
  bytes: number;
  sha256: string;
};

type PickupRecord = {
  sender_user_id: string;
  variant: PickupVariant;
  offer: string;
  answer: string | null;
  receiver_user_id: string | null;
  selection_route: PickupRoute | null;
  winner_route: PickupRoute | null;
  winner_bytes: number | null;
  winner_sha256: string | null;
  cancelled_at: number | null;
  expires_at: number;
};

type LookupResult =
  | { status: "found"; variant: PickupVariant; offer: string; expiresAt: number; answered: boolean }
  | { status: "missing" | "expired" | "cancelled" };

type AnswerResult =
  | { status: "found"; answer: string | null }
  | { status: "missing" | "expired" | "forbidden" | "cancelled" };

type SubmitResult = { status: "ok" | "missing" | "expired" | "answered" | "cancelled" };

type SelectionResult =
  | { status: "found"; route: PickupRoute | null }
  | { status: "missing" | "expired" | "forbidden" | "cancelled" };

type SubmitSelectionResult = {
  status: "ok" | "missing" | "expired" | "forbidden" | "won" | "cancelled";
};

type WinnerResult =
  | { status: "found"; winner: PickupWinner | null }
  | { status: "missing" | "expired" | "forbidden" | "cancelled" };

type SubmitWinnerResult = {
  status: "ok" | "missing" | "expired" | "forbidden" | "won" | "cancelled";
};

type CancelResult = { status: "ok" | "missing" | "expired" | "forbidden" | "won" };

type StatusResult =
  | { status: "found"; cancelled: boolean; expiresAt: number }
  | { status: "missing" | "expired" | "forbidden" };

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
          selection_route TEXT,
          winner_route TEXT,
          winner_bytes INTEGER,
          winner_sha256 TEXT,
          cancelled_at INTEGER,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      this.addColumnIfMissing("selection_route", "TEXT");
      this.addColumnIfMissing("winner_route", "TEXT");
      this.addColumnIfMissing("winner_bytes", "INTEGER");
      this.addColumnIfMissing("winner_sha256", "TEXT");
      this.addColumnIfMissing("cancelled_at", "INTEGER");
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
         (singleton, sender_user_id, variant, offer, answer, receiver_user_id,
          selection_route, winner_route, winner_bytes, winner_sha256, cancelled_at, expires_at, created_at)
       VALUES (1, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
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
    if (record.cancelled_at !== null) return { status: "cancelled" };
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
    if (record.cancelled_at !== null) return { status: "cancelled" };
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
    if (record.cancelled_at !== null) return { status: "cancelled" };
    return { status: "found", answer: record.answer };
  }

  async submitSelection(senderUserId: string, route: PickupRoute): Promise<SubmitSelectionResult> {
    const record = this.readActiveRecord();
    if (!record) return this.readRecord() ? { status: "expired" } : { status: "missing" };
    if (record.sender_user_id !== senderUserId) return { status: "forbidden" };
    if (record.cancelled_at !== null) return { status: "cancelled" };
    if (record.winner_route !== null) return { status: "won" };
    if (record.selection_route === route) return { status: "ok" };

    const result = this.ctx.storage.sql.exec(
      "UPDATE pickup_session SET selection_route = ? WHERE singleton = 1 AND winner_route IS NULL",
      route,
    );
    return result.rowsWritten === 1 ? { status: "ok" } : { status: "won" };
  }

  async getSelection(receiverUserId: string): Promise<SelectionResult> {
    const record = this.readActiveRecord();
    if (!record) return this.readRecord() ? { status: "expired" } : { status: "missing" };
    if (record.receiver_user_id !== receiverUserId) return { status: "forbidden" };
    if (record.cancelled_at !== null) return { status: "cancelled" };
    return { status: "found", route: record.selection_route };
  }

  async submitWinner(receiverUserId: string, winner: PickupWinner): Promise<SubmitWinnerResult> {
    const record = this.readActiveRecord();
    if (!record) return this.readRecord() ? { status: "expired" } : { status: "missing" };
    if (record.receiver_user_id !== receiverUserId) return { status: "forbidden" };
    if (record.cancelled_at !== null) return { status: "cancelled" };
    if (record.winner_route !== null) {
      return record.winner_route === winner.route &&
        record.winner_bytes === winner.bytes &&
        record.winner_sha256 === winner.sha256
        ? { status: "ok" }
        : { status: "won" };
    }

    const result = this.ctx.storage.sql.exec(
      `UPDATE pickup_session
       SET winner_route = ?, winner_bytes = ?, winner_sha256 = ?
       WHERE singleton = 1 AND winner_route IS NULL`,
      winner.route,
      winner.bytes,
      winner.sha256,
    );
    return result.rowsWritten === 1 ? { status: "ok" } : { status: "won" };
  }

  async getWinner(senderUserId: string): Promise<WinnerResult> {
    const record = this.readActiveRecord();
    if (!record) return this.readRecord() ? { status: "expired" } : { status: "missing" };
    if (record.sender_user_id !== senderUserId) return { status: "forbidden" };
    if (record.cancelled_at !== null) return { status: "cancelled" };
    const winner =
      record.winner_route === null || record.winner_bytes === null || record.winner_sha256 === null
        ? null
        : {
            route: record.winner_route,
            bytes: record.winner_bytes,
            sha256: record.winner_sha256,
          };
    return { status: "found", winner };
  }

  async cancel(userId: string): Promise<CancelResult> {
    const record = this.readActiveRecord();
    if (!record) return this.readRecord() ? { status: "expired" } : { status: "missing" };
    if (record.sender_user_id !== userId && record.receiver_user_id !== userId) {
      return { status: "forbidden" };
    }
    if (record.winner_route !== null) return { status: "won" };
    if (record.cancelled_at === null) {
      this.ctx.storage.sql.exec(
        "UPDATE pickup_session SET cancelled_at = ? WHERE singleton = 1 AND cancelled_at IS NULL",
        Date.now(),
      );
    }
    return { status: "ok" };
  }

  async getStatus(userId: string): Promise<StatusResult> {
    const record = this.readActiveRecord();
    if (!record) return this.readRecord() ? { status: "expired" } : { status: "missing" };
    if (record.sender_user_id !== userId && record.receiver_user_id !== userId) {
      return { status: "forbidden" };
    }
    return {
      status: "found",
      cancelled: record.cancelled_at !== null,
      expiresAt: record.expires_at,
    };
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

  private addColumnIfMissing(name: string, type: "TEXT" | "INTEGER") {
    const columns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(pickup_session)").toArray();
    if (!columns.some((column) => column.name === name)) {
      this.ctx.storage.sql.exec(`ALTER TABLE pickup_session ADD COLUMN ${name} ${type}`);
    }
  }
}
