import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { walletAccountsTable } from "./wallets";
import { walletReservationsTable } from "./reservations";
import { userBankAccountsTable } from "./bank-accounts";

/**
 * Lifecycle states for a withdrawal request.
 *
 * reserved   → Reservation created, funds locked. Awaiting background job submission.
 * processing → Submitted to payout provider. Awaiting provider webhook or reconciliation.
 * completed  → Provider confirmed payout. Reservation confirmed; balance permanently debited.
 * failed     → Provider rejected or timed out. Reservation released; funds returned.
 * cancelled  → Cancelled by user (only valid from `reserved`). Reservation released.
 *
 * Valid transitions:
 *   reserved  → processing   (background submission job)
 *   reserved  → cancelled    (user cancels before submission)
 *   reserved  → failed       (submission rejected after MAX_SUBMISSION_ATTEMPTS)
 *   processing → completed   (provider webhook success / reconciliation)
 *   processing → failed      (provider webhook failure / reconciliation / 24h alert)
 */
export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "reserved",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * One row per withdrawal request. Spans the full lifecycle from fund lock to
 * payout confirmation or failure.
 *
 * FK chain (all RESTRICT):
 *   withdrawal → reservation → wallet_account → user
 *   withdrawal → bank_account → user
 *
 * The reservation row is the single source of truth for how much is locked;
 * `amount` here is a denormalized copy for query convenience.
 */
export const withdrawalsTable = pgTable(
  "withdrawals",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),

    // The Winning Coins wallet account from which the payout is drawn.
    walletAccountId: uuid("wallet_account_id")
      .notNull()
      .references(() => walletAccountsTable.id, { onDelete: "restrict" }),

    // One-to-one link to the reservation that locks the coins.
    // UNIQUE constraint: each reservation can only be used by one withdrawal.
    // ON DELETE RESTRICT: reservation cannot be deleted while linked here.
    reservationId: uuid("reservation_id")
      .notNull()
      .unique("withdrawals_reservation_id_unique")
      .references(() => walletReservationsTable.id, { onDelete: "restrict" }),

    // The pre-registered bank account selected by the user.
    // ON DELETE RESTRICT: user cannot delete a bank account referenced by any
    // withdrawal (active or historical). Use soft delete on bank accounts instead.
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => userBankAccountsTable.id, { onDelete: "restrict" }),

    // ── Immutable snapshot of bank details at request time ───────────────
    // Captured from the referenced bank account row at initiation and stored
    // denormalized. Ensures the withdrawal audit record is accurate even if
    // the bank account is later soft-deleted or if its editable metadata changes.
    snapshotAccountHolderName: text("snapshot_account_holder_name").notNull(),
    // Full account number stored for payout submission. Never returned in full
    // via the API — responses expose only the last 4 digits.
    snapshotBankAccountNumber: text("snapshot_bank_account_number").notNull(),
    snapshotBankIfscCode: text("snapshot_bank_ifsc_code").notNull(),
    snapshotBankName: text("snapshot_bank_name"),

    // Whole Winning Coins to pay out. 1 coin = ₹1. Positive; validated at service layer.
    amount: bigint("amount", { mode: "number" }).notNull(),

    status: withdrawalStatusEnum("status").notNull().default("reserved"),

    // ── Payout provider fields ───────────────────────────────────────────
    // Populated when the background job successfully submits to the provider.
    // `provider` stores the provider name (e.g. "payu") so historical records
    // remain interpretable even after a provider switch.
    provider: text("provider"),
    providerReference: text("provider_reference"),
    providerSubmittedAt: timestamp("provider_submitted_at", { withTimezone: true }),

    // Number of times the background job has attempted to submit this withdrawal
    // to the payout provider. Incremented atomically before each attempt.
    // When this reaches MAX_SUBMISSION_ATTEMPTS the withdrawal is permanently failed.
    submissionAttempts: integer("submission_attempts").notNull().default(0),

    // Timestamp of the most recent submission attempt. Acts as a short-lived
    // lease: the background job filters out rows where this is more recent than
    // SUBMISSION_LEASE_DURATION, preventing concurrent workers from double-submitting
    // the same withdrawal to the provider during the HTTP round-trip.
    // NULL until the first submission attempt.
    lastSubmissionAttemptAt: timestamp("last_submission_attempt_at", {
      withTimezone: true,
    }),

    // ── Terminal state metadata ──────────────────────────────────────────
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    // Human-readable reason for failure (from provider rejection or timeout).
    failureReason: text("failure_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // Populated on user-initiated cancellation. Empty string for system cancellations.
    cancellationReason: text("cancellation_reason"),

    // ── Idempotency ──────────────────────────────────────────────────────
    // Client-supplied key. A POST /withdrawals retry with the same key and same
    // parameters returns the existing withdrawal without creating a duplicate.
    // Unique constraint is the DB-level backstop; the service checks it first
    // under a FOR UPDATE lock to surface a clean error before hitting the constraint.
    idempotencyKey: text("idempotency_key").notNull().unique(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check("withdrawals_amount_positive", sql`${table.amount} > 0`),

    // User withdrawal history listing: WHERE user_id = $1 ORDER BY created_at DESC.
    index("withdrawals_user_id_created_at_idx").on(table.userId, table.createdAt),

    // Background submission job: WHERE status = 'reserved' ORDER BY created_at ASC.
    // Reconciliation job: WHERE status = 'processing' ORDER BY created_at ASC.
    index("withdrawals_status_created_at_idx").on(table.status, table.createdAt),

    // Webhook and reconciliation lookup: WHERE provider = $1 AND provider_reference = $2.
    // Both columns are NULL until submission; the partial index is a logical concern
    // only — Drizzle does not support partial indexes, so we index both columns and
    // accept that NULL rows are included.
    index("withdrawals_provider_reference_idx").on(
      table.provider,
      table.providerReference,
    ),
  ],
);

export const insertWithdrawalSchema = createInsertSchema(withdrawalsTable).omit({
  // Status is always 'reserved' on creation; the service never accepts it from callers.
  status: true,
  // Provider fields are populated by the submission job, not the creator.
  provider: true,
  providerReference: true,
  providerSubmittedAt: true,
  submissionAttempts: true,
  lastSubmissionAttemptAt: true,
  // Terminal state fields are populated only on final transitions.
  completedAt: true,
  failedAt: true,
  failureReason: true,
  cancelledAt: true,
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWithdrawal = z.infer<typeof insertWithdrawalSchema>;
export type Withdrawal = typeof withdrawalsTable.$inferSelect;
