/**
 * Withdrawal service — initiation and cancellation.
 *
 * ── Responsibility boundary ───────────────────────────────────────────────────
 *
 *   This module owns:
 *     - initiateWithdrawal   — create a withdrawal + reservation atomically
 *     - cancelWithdrawal     — cancel (only valid from `reserved` state)
 *     - getWithdrawal        — fetch a single withdrawal with ownership check
 *     - getUserWithdrawals   — paginated list for a user
 *
 *   withdrawal-completion.ts owns completeWithdrawal and failWithdrawal (shared
 *   by the webhook path and the reconciliation job).
 *
 * ── Concurrency contract ──────────────────────────────────────────────────────
 *
 *   All mutations acquire a FOR UPDATE lock on the wallet account FIRST, before
 *   reading any derived state (idempotency key, active withdrawal count). This
 *   serializes all concurrent withdrawal requests from the same user against the
 *   same lock, closing the TOCTOU window between "check no active withdrawal"
 *   and "create reservation".
 *
 *   Lock order for mutations that touch an existing withdrawal row:
 *     1. withdrawal row  (FOR UPDATE)
 *     2. wallet account  (FOR UPDATE — inside releaseReservation)
 *     3. reservation row (FOR UPDATE — inside releaseReservation)
 *
 *   This order is consistent with withdrawal-completion.ts and prevents deadlocks
 *   between concurrent cancellations and webhook completions.
 *
 * ── Limits extensibility ──────────────────────────────────────────────────────
 *
 *   Per-request, daily, and monthly limits are not implemented. The architecture
 *   is ready: add a `checkWithdrawalLimits(tx, userId, amount)` call inside
 *   `initiateWithdrawal` (after the wallet lock, before the reservation) without
 *   touching any other code path. A `withdrawal_limit_configs` table or a hard-
 *   coded constant can back that function.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import {
  db,
  userBankAccountsTable,
  walletAccountsTable,
  withdrawalsTable,
  type Withdrawal,
} from "@workspace/db";
import { createReservation, releaseReservation, InsufficientAvailableBalanceError } from "./reservation";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum Winning Coins per withdrawal request. 1 coin = ₹1, so this is ₹100. */
export const MINIMUM_WITHDRAWAL_AMOUNT = 100;

// ── Transaction guard ─────────────────────────────────────────────────────────

type DbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

function assertIsTransaction(executor: DbExecutor, fnName: string): void {
  if (executor === (db as unknown)) {
    throw new Error(
      `${fnName}() must be called inside a db.transaction() context. ` +
        `Calling it with the bare 'db' makes its operations non-atomic.`,
    );
  }
}

// ── Error types ───────────────────────────────────────────────────────────────

export class WithdrawalAmountBelowMinimumError extends Error {
  constructor() {
    super(
      `Withdrawal amount must be at least ${MINIMUM_WITHDRAWAL_AMOUNT} Winning Coins (₹${MINIMUM_WITHDRAWAL_AMOUNT}).`,
    );
    this.name = "WithdrawalAmountBelowMinimumError";
  }
}

export class ActiveWithdrawalExistsError extends Error {
  constructor() {
    super(
      "You already have a pending withdrawal (reserved or processing). " +
        "Only one active withdrawal is allowed at a time. " +
        "Wait for it to complete or cancel it before requesting another.",
    );
    this.name = "ActiveWithdrawalExistsError";
  }
}

export class WithdrawalBankAccountNotFoundError extends Error {
  constructor(id: string) {
    super(
      `Bank account ${id} not found, does not belong to this user, or has been removed.`,
    );
    this.name = "WithdrawalBankAccountNotFoundError";
  }
}

export class DuplicateWithdrawalIdempotencyKeyError extends Error {
  constructor() {
    super(
      "A withdrawal with this idempotency key already exists with different parameters. " +
        "Use a new idempotency key for a different withdrawal request.",
    );
    this.name = "DuplicateWithdrawalIdempotencyKeyError";
  }
}

export class WithdrawalNotFoundError extends Error {
  constructor(id: string) {
    super(`Withdrawal ${id} not found or does not belong to this user.`);
    this.name = "WithdrawalNotFoundError";
  }
}

export class WithdrawalCannotBeCancelledError extends Error {
  constructor(status: string) {
    super(
      `Withdrawal cannot be cancelled: current status is "${status}". ` +
        `Cancellation is only allowed while the withdrawal is in "reserved" state ` +
        `(before it has been submitted to the payout provider).`,
    );
    this.name = "WithdrawalCannotBeCancelledError";
  }
}

// Re-export for use in route handlers without requiring them to import reservation.ts.
export { InsufficientAvailableBalanceError };

// ── initiateWithdrawal ────────────────────────────────────────────────────────

export interface InitiateWithdrawalInput {
  userId: string;
  /** Winning Coins to withdraw. Must be >= MINIMUM_WITHDRAWAL_AMOUNT. */
  amount: number;
  /** ID of a pre-registered, non-deleted bank account belonging to this user. */
  bankAccountId: string;
  /**
   * Client-supplied idempotency key. A retry with the same key and the same
   * amount + bankAccountId returns the existing withdrawal without creating a
   * duplicate. A retry with the same key but different parameters throws
   * `DuplicateWithdrawalIdempotencyKeyError`.
   */
  idempotencyKey: string;
}

export interface InitiateWithdrawalResult {
  withdrawal: Withdrawal;
  /** `true` on first creation, `false` on an idempotent return of an existing record. */
  created: boolean;
}

/**
 * Creates a new withdrawal and atomically locks the requested coins via a
 * reservation. Must be called inside a `db.transaction(...)`.
 *
 * ── Operation order (do not reorder) ─────────────────────────────────────────
 *
 *  1. Lock wallet account (FOR UPDATE) — serializes all concurrent withdrawals.
 *  2. Idempotency check (reads committed state under lock).
 *  3. Active withdrawal check (reads committed state under lock).
 *  4. Amount validation.
 *  5. Bank account lookup.
 *  6. createReservation — increments reserved_balance.
 *  7. Insert withdrawal row with pre-generated UUID.
 *
 * Throws:
 *  - `WithdrawalAmountBelowMinimumError`
 *  - `ActiveWithdrawalExistsError`
 *  - `WithdrawalBankAccountNotFoundError`
 *  - `DuplicateWithdrawalIdempotencyKeyError`
 *  - `InsufficientAvailableBalanceError` (from createReservation)
 */
export async function initiateWithdrawal(
  tx: DbExecutor,
  input: InitiateWithdrawalInput,
): Promise<InitiateWithdrawalResult> {
  assertIsTransaction(tx, "initiateWithdrawal");

  // ── Step 1: Lock the user's Winning Coins wallet account ────────────────────
  // All subsequent reads are consistent under this lock. Two concurrent
  // requests for the same user will serialise here — only one proceeds at a time.
  const [winningAccount] = await tx
    .select()
    .from(walletAccountsTable)
    .where(
      and(
        eq(walletAccountsTable.userId, input.userId),
        eq(walletAccountsTable.walletType, "winning_coins"),
      ),
    )
    .for("update");

  if (!winningAccount) {
    throw new Error(`Winning Coins wallet not found for user ${input.userId}.`);
  }

  // ── Step 2: Idempotency check ───────────────────────────────────────────────
  const [existing] = await tx
    .select()
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (existing) {
    // Same key, same params → idempotent return.
    if (existing.amount === input.amount && existing.bankAccountId === input.bankAccountId) {
      return { withdrawal: existing, created: false };
    }
    // Same key, different params → programming error on the client.
    throw new DuplicateWithdrawalIdempotencyKeyError();
  }

  // ── Step 3: One active withdrawal per user ──────────────────────────────────
  const [activeWithdrawal] = await tx
    .select({ id: withdrawalsTable.id })
    .from(withdrawalsTable)
    .where(
      and(
        eq(withdrawalsTable.userId, input.userId),
        inArray(withdrawalsTable.status, ["reserved", "processing"]),
      ),
    )
    .limit(1);

  if (activeWithdrawal) {
    throw new ActiveWithdrawalExistsError();
  }

  // ── Step 4: Amount validation ───────────────────────────────────────────────
  if (input.amount < MINIMUM_WITHDRAWAL_AMOUNT) {
    throw new WithdrawalAmountBelowMinimumError();
  }

  // ── Step 5: Bank account lookup ─────────────────────────────────────────────
  // Must belong to this user and not be soft-deleted.
  const [bankAccount] = await tx
    .select()
    .from(userBankAccountsTable)
    .where(
      and(
        eq(userBankAccountsTable.id, input.bankAccountId),
        eq(userBankAccountsTable.userId, input.userId),
        eq(userBankAccountsTable.isDeleted, false),
      ),
    )
    .limit(1);

  if (!bankAccount) {
    throw new WithdrawalBankAccountNotFoundError(input.bankAccountId);
  }

  // ── Step 6: Create reservation ──────────────────────────────────────────────
  // Pre-generate the withdrawal UUID so the reservation can reference it
  // as `reasonId` within the same transaction, before the withdrawal row exists.
  const withdrawalId = randomUUID();

  const reservation = await createReservation(tx, {
    walletAccountId: winningAccount.id,
    amount: input.amount,
    reasonType: "withdrawal",
    reasonId: withdrawalId,
    idempotencyKey: `withdrawal:${input.idempotencyKey}:reservation`,
  });

  // ── Step 7: Insert withdrawal row ───────────────────────────────────────────
  const [withdrawal] = await tx
    .insert(withdrawalsTable)
    .values({
      id: withdrawalId,
      userId: input.userId,
      walletAccountId: winningAccount.id,
      reservationId: reservation.id,
      bankAccountId: input.bankAccountId,
      // Immutable snapshot of bank details at request time.
      snapshotAccountHolderName: bankAccount.accountHolderName,
      snapshotBankAccountNumber: bankAccount.bankAccountNumber,
      snapshotBankIfscCode: bankAccount.bankIfscCode,
      snapshotBankName: bankAccount.bankName ?? null,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();

  if (!withdrawal) {
    throw new Error("Failed to insert withdrawal after insert.");
  }

  return { withdrawal, created: true };
}

// ── cancelWithdrawal ──────────────────────────────────────────────────────────

/**
 * Cancels a withdrawal that is in the `reserved` state, releasing the locked
 * coins back to the user's available balance. Must be called inside a
 * `db.transaction(...)`.
 *
 * Lock order: withdrawal row → wallet account → reservation (consistent with
 * completeWithdrawal and failWithdrawal in withdrawal-completion.ts).
 *
 * Throws:
 *  - `WithdrawalNotFoundError` — not found or wrong user
 *  - `WithdrawalCannotBeCancelledError` — not in `reserved` state
 */
export async function cancelWithdrawal(
  tx: DbExecutor,
  withdrawalId: string,
  userId: string,
  cancellationReason?: string,
): Promise<Withdrawal> {
  assertIsTransaction(tx, "cancelWithdrawal");

  // Lock the withdrawal row to prevent concurrent cancellation and submission.
  const [withdrawal] = await tx
    .select()
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.id, withdrawalId))
    .for("update");

  if (!withdrawal || withdrawal.userId !== userId) {
    throw new WithdrawalNotFoundError(withdrawalId);
  }

  // Idempotent: already cancelled.
  if (withdrawal.status === "cancelled") {
    return withdrawal;
  }

  // Only `reserved` withdrawals can be cancelled.
  if (withdrawal.status !== "reserved") {
    throw new WithdrawalCannotBeCancelledError(withdrawal.status);
  }

  // Release the reservation: decrements reserved_balance, marks reservation released.
  // Lock order inside releaseReservation: wallet account → reservation.
  await releaseReservation(tx, withdrawal.reservationId);

  // Mark the withdrawal as cancelled.
  const [cancelled] = await tx
    .update(withdrawalsTable)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancellationReason: cancellationReason ?? null,
    })
    .where(eq(withdrawalsTable.id, withdrawalId))
    .returning();

  if (!cancelled) {
    throw new Error(`Failed to update withdrawal ${withdrawalId} to cancelled.`);
  }

  return cancelled;
}

// ── Read functions ────────────────────────────────────────────────────────────

/**
 * Returns a single withdrawal by ID, with ownership validation.
 * Returns `null` if not found or if the withdrawal belongs to a different user.
 */
export async function getWithdrawal(
  id: string,
  userId: string,
): Promise<Withdrawal | null> {
  const [withdrawal] = await db
    .select()
    .from(withdrawalsTable)
    .where(
      and(
        eq(withdrawalsTable.id, id),
        eq(withdrawalsTable.userId, userId),
      ),
    )
    .limit(1);

  return withdrawal ?? null;
}

export interface GetUserWithdrawalsQuery {
  userId: string;
  limit: number;
  before?: Date;
}

/** Returns a page of a user's withdrawals, newest first. */
export async function getUserWithdrawals(
  query: GetUserWithdrawalsQuery,
): Promise<Withdrawal[]> {
  const conditions = [eq(withdrawalsTable.userId, query.userId)];
  if (query.before) {
    conditions.push(lt(withdrawalsTable.createdAt, query.before));
  }

  return db
    .select()
    .from(withdrawalsTable)
    .where(and(...conditions))
    .orderBy(desc(withdrawalsTable.createdAt))
    .limit(query.limit);
}
