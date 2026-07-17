import { and, eq, sql } from "drizzle-orm";
import {
  db,
  walletAccountsTable,
  walletReservationsTable,
  walletTransactionsTable,
  type WalletReservation,
  type WalletTransaction,
} from "@workspace/db";
import {
  recordCompletedTransaction,
  InsufficientAvailableBalanceError,
  type RecordTransactionInput,
} from "./wallet";

// A database client that can either be the top-level `db` or a transaction
// handle (`tx`) passed down from `db.transaction(...)`.
type DbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

export type ReservationReasonType =
  | "withdrawal"
  | "tournament_entry"
  | "admin_hold"
  | "fraud_hold"
  | "bonus_hold";

// ─── createReservation ────────────────────────────────────────────────────────

export interface CreateReservationInput {
  walletAccountId: string;
  /** Must be a positive integer. */
  amount: number;
  reasonType: ReservationReasonType;
  /** ID of the owning entity in the originating module (e.g. withdrawal ID). */
  reasonId?: string;
  /**
   * Client-supplied key that makes creation idempotent. A retry with the
   * same key returns the existing reservation without double-incrementing
   * reserved_balance.
   */
  idempotencyKey: string;
}

/**
 * Creates an active reservation that locks `amount` coins on a wallet account
 * by incrementing `reserved_balance`. The coins remain in the ledger balance
 * but are excluded from `available_balance` until the reservation is confirmed
 * or released.
 *
 * Must be called inside a `db.transaction(...)` so the wallet account update
 * and the reservation insert are atomic.
 *
 * Throws `InsufficientAvailableBalanceError` when
 * `account.balance - account.reservedBalance < input.amount`.
 *
 * Idempotent on `idempotencyKey`: a retry returns the existing reservation
 * without modifying the wallet account.
 */
export async function createReservation(
  tx: DbExecutor,
  input: CreateReservationInput,
): Promise<WalletReservation> {
  // Lock the wallet account first so the available-balance check and the
  // reserved_balance increment are serialized against all concurrent
  // operations targeting this account.
  const [account] = await tx
    .select()
    .from(walletAccountsTable)
    .where(eq(walletAccountsTable.id, input.walletAccountId))
    .for("update");

  if (!account) {
    throw new Error(`Wallet account ${input.walletAccountId} does not exist.`);
  }

  // Idempotency check runs after the lock so it always reads committed state,
  // eliminating the TOCTOU window between "check key" and "insert row".
  const [existing] = await tx
    .select()
    .from(walletReservationsTable)
    .where(eq(walletReservationsTable.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (existing) {
    return existing;
  }

  // available_balance = balance - reservedBalance. The debit will only be
  // applied at confirmation; for now we just lock the coins.
  const available = account.balance - account.reservedBalance;
  if (available < input.amount) {
    throw new InsufficientAvailableBalanceError(account.walletType);
  }

  // Increment reserved_balance.
  await tx
    .update(walletAccountsTable)
    .set({
      reservedBalance: sql`${walletAccountsTable.reservedBalance} + ${input.amount}`,
    })
    .where(eq(walletAccountsTable.id, input.walletAccountId));

  // Insert the reservation row.
  const [reservation] = await tx
    .insert(walletReservationsTable)
    .values({
      walletAccountId: input.walletAccountId,
      amount: input.amount,
      reasonType: input.reasonType,
      reasonId: input.reasonId,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();

  if (!reservation) {
    throw new Error("Failed to insert wallet reservation.");
  }

  return reservation;
}

// ─── releaseReservation ───────────────────────────────────────────────────────

/**
 * Releases an active reservation (e.g. withdrawal cancelled or failed before
 * processing). Decrements `reserved_balance` and marks the reservation as
 * `released`. No ledger entry is written — the user's settled balance was
 * never changed.
 *
 * Idempotent: releasing an already-released reservation is a no-op (returns
 * the existing reservation). Throws if the reservation is already confirmed
 * (coins have already been debited; use a credit/reversal instead).
 *
 * Must be called inside a `db.transaction(...)`.
 */
export async function releaseReservation(
  tx: DbExecutor,
  reservationId: string,
): Promise<WalletReservation> {
  // Unlocked pre-read to learn which wallet account to lock. The
  // walletAccountId field is immutable after creation.
  const [info] = await tx
    .select({
      walletAccountId: walletReservationsTable.walletAccountId,
    })
    .from(walletReservationsTable)
    .where(eq(walletReservationsTable.id, reservationId))
    .limit(1);

  if (!info) {
    throw new Error(`Reservation ${reservationId} does not exist.`);
  }

  // Lock wallet account first (consistent ordering: wallet before reservation).
  await tx
    .select({ id: walletAccountsTable.id })
    .from(walletAccountsTable)
    .where(eq(walletAccountsTable.id, info.walletAccountId))
    .for("update");

  // Now lock the reservation row for fresh data.
  const [reservation] = await tx
    .select()
    .from(walletReservationsTable)
    .where(eq(walletReservationsTable.id, reservationId))
    .for("update");

  if (!reservation) {
    throw new Error(`Reservation ${reservationId} does not exist.`);
  }

  if (reservation.status === "released") {
    // Idempotent — already released; no wallet account changes needed.
    return reservation;
  }

  if (reservation.status === "confirmed") {
    throw new Error(
      `Reservation ${reservationId} has already been confirmed (balance debited). ` +
        `Use a credit transaction to reverse the debit instead of releasing the reservation.`,
    );
  }

  // Decrement reserved_balance.
  await tx
    .update(walletAccountsTable)
    .set({
      reservedBalance: sql`${walletAccountsTable.reservedBalance} - ${reservation.amount}`,
    })
    .where(eq(walletAccountsTable.id, reservation.walletAccountId));

  // Mark reservation as released.
  const [released] = await tx
    .update(walletReservationsTable)
    .set({ status: "released", releasedAt: new Date() })
    .where(eq(walletReservationsTable.id, reservationId))
    .returning();

  if (!released) {
    throw new Error("Failed to update reservation status to released.");
  }

  return released;
}

// ─── confirmReservation ───────────────────────────────────────────────────────

export interface ConfirmReservationInput {
  reservationId: string;
  /**
   * Idempotency key for the resulting `wallet_transactions` ledger entry.
   * Must be unique across all wallet transactions. A retry with the same key
   * returns the existing ledger entry without double-debiting.
   */
  transactionIdempotencyKey: string;
  /** Passed through to the ledger entry's reference_type column. */
  referenceType?: string;
  /** Passed through to the ledger entry's reference_id column. */
  referenceId?: string;
  /** Human-readable description for the ledger entry. */
  description?: string;
}

/**
 * Confirms a reservation: permanently debits the reserved coins from the
 * wallet account and records an immutable ledger entry.
 *
 * **Critical operation order (do not reorder):**
 * 1. Decrement `reserved_balance` first.
 * 2. Call `recordCompletedTransaction` (debits `balance`) second.
 *
 * PostgreSQL evaluates CHECK constraints at statement level, not at transaction
 * commit. If multiple reservations are active and `balance` is decremented
 * before `reserved_balance`, the intermediate state `balance < reserved_balance`
 * violates the DB constraint mid-transaction. This order avoids that.
 *
 * Idempotent on `transactionIdempotencyKey`: if the reservation is already
 * confirmed and the ledger entry exists, returns both without any writes.
 *
 * Must be called inside a `db.transaction(...)`.
 */
export async function confirmReservation(
  tx: DbExecutor,
  input: ConfirmReservationInput,
): Promise<{ reservation: WalletReservation; transaction: WalletTransaction }> {
  // Unlocked pre-read to learn which wallet account to lock.
  const [info] = await tx
    .select({
      walletAccountId: walletReservationsTable.walletAccountId,
    })
    .from(walletReservationsTable)
    .where(eq(walletReservationsTable.id, input.reservationId))
    .limit(1);

  if (!info) {
    throw new Error(`Reservation ${input.reservationId} does not exist.`);
  }

  // Lock wallet account first (consistent ordering: wallet before reservation).
  await tx
    .select({ id: walletAccountsTable.id })
    .from(walletAccountsTable)
    .where(eq(walletAccountsTable.id, info.walletAccountId))
    .for("update");

  // Now lock the reservation row for fresh data.
  const [reservation] = await tx
    .select()
    .from(walletReservationsTable)
    .where(eq(walletReservationsTable.id, input.reservationId))
    .for("update");

  if (!reservation) {
    throw new Error(`Reservation ${input.reservationId} does not exist.`);
  }

  if (reservation.status === "released") {
    throw new Error(
      `Reservation ${input.reservationId} has been released and cannot be confirmed.`,
    );
  }

  if (reservation.status === "confirmed") {
    // Idempotent — already confirmed. Return existing ledger entry.
    const [existingTx] = await tx
      .select()
      .from(walletTransactionsTable)
      .where(eq(walletTransactionsTable.idempotencyKey, input.transactionIdempotencyKey))
      .limit(1);

    if (!existingTx) {
      throw new Error(
        `Reservation ${input.reservationId} is confirmed but no wallet transaction ` +
          `found for idempotency key "${input.transactionIdempotencyKey}". ` +
          `Ensure transactionIdempotencyKey matches the key used during the original confirmation.`,
      );
    }

    return { reservation, transaction: existingTx };
  }

  // ── Step 1: Decrement reserved_balance FIRST ────────────────────────────────
  // This MUST happen before the balance debit in step 2. See JSDoc above.
  await tx
    .update(walletAccountsTable)
    .set({
      reservedBalance: sql`${walletAccountsTable.reservedBalance} - ${reservation.amount}`,
    })
    .where(eq(walletAccountsTable.id, reservation.walletAccountId));

  // ── Step 2: Debit balance via recordCompletedTransaction ────────────────────
  // recordCompletedTransaction re-acquires the FOR UPDATE lock on the wallet
  // account (same tx, same row — allowed by PostgreSQL). It will read the
  // already-decremented reserved_balance from step 1, so its
  // `balanceAfter >= account.reservedBalance` check uses the post-decrement
  // value, which is correct.
  const walletTx = await recordCompletedTransaction(tx, {
    walletAccountId: reservation.walletAccountId,
    amount: -reservation.amount,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    idempotencyKey: input.transactionIdempotencyKey,
    description: input.description,
  });

  // ── Step 3: Mark reservation as confirmed ───────────────────────────────────
  const [confirmed] = await tx
    .update(walletReservationsTable)
    .set({ status: "confirmed", confirmedAt: new Date() })
    .where(eq(walletReservationsTable.id, input.reservationId))
    .returning();

  if (!confirmed) {
    throw new Error("Failed to update reservation status to confirmed.");
  }

  return { reservation: confirmed, transaction: walletTx };
}

// ─── getReservation ───────────────────────────────────────────────────────────

/** Returns a reservation by ID, or null if it does not exist. */
export async function getReservation(id: string): Promise<WalletReservation | null> {
  const [reservation] = await db
    .select()
    .from(walletReservationsTable)
    .where(eq(walletReservationsTable.id, id))
    .limit(1);

  return reservation ?? null;
}

// ─── getActiveReservationsForAccount ─────────────────────────────────────────

/**
 * Returns all active (not yet confirmed or released) reservations for a
 * wallet account, ordered oldest first. Useful for display and auditing.
 */
export async function getActiveReservationsForAccount(
  walletAccountId: string,
): Promise<WalletReservation[]> {
  return db
    .select()
    .from(walletReservationsTable)
    .where(
      and(
        eq(walletReservationsTable.walletAccountId, walletAccountId),
        eq(walletReservationsTable.status, "active"),
      ),
    )
    .orderBy(walletReservationsTable.createdAt);
}
