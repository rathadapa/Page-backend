/**
 * Shared deposit-completion service.
 *
 * This module owns the business logic for writing a finalised deposit state
 * to the database.  It is intentionally decoupled from the payment gateway
 * that sourced the event so that it can be called from two places:
 *
 *   1. PayU webhook handlers (`lib/payu.ts`)
 *      Called when PayU POSTs a success/failure callback to our server.
 *
 *   2. Reconciliation job (Phase 4 — not yet implemented)
 *      Called when the scheduler polls the PayU Verify Payment API for
 *      deposits that stayed `pending` after a missed webhook.
 *
 * Contract for callers
 * ────────────────────
 * Both functions expect to be called **inside an existing DB transaction**
 * after the caller has already:
 *
 *   a) Acquired a `SELECT … FOR UPDATE` row lock on the deposit.
 *   b) Verified `deposit.status === "pending"` (idempotency guard).
 *
 * The functions do NOT open a new transaction; they enlist in the caller's
 * transaction so that every mutation is committed or rolled back atomically
 * together with the lock and any other caller-side work.
 *
 * Usage example (webhook):
 *
 *   await db.transaction(async (tx) => {
 *     const [deposit] = await tx.select().from(depositsTable)
 *       .where(eq(depositsTable.merchantOrderId, txnid)).for("update");
 *     if (!deposit) throw new DepositNotFoundError(txnid);
 *     if (deposit.status !== "pending") throw new DepositAlreadyCompletedError(deposit);
 *
 *     await completeSuccessfulDeposit(tx, deposit, { mihpayid });
 *   });
 *
 * Usage example (reconciliation job):
 *
 *   await db.transaction(async (tx) => {
 *     const [deposit] = await tx.select().from(depositsTable)
 *       .where(eq(depositsTable.merchantOrderId, merchantOrderId)).for("update");
 *     if (!deposit || deposit.status !== "pending") return; // already handled
 *
 *     if (verifyResult.status === "success") {
 *       await completeSuccessfulDeposit(tx, deposit, { mihpayid: verifyResult.mihpayid });
 *     } else {
 *       await completeFailedDeposit(tx, deposit, { failureReason: verifyResult.field9 });
 *     }
 *   });
 */

import { and, eq } from "drizzle-orm";
import { db, depositsTable, walletAccountsTable, type Deposit } from "@workspace/db";
import { recordCompletedTransaction } from "./wallet";

/** Matches the transaction-executor type used throughout the codebase. */
type DbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

// ── completeSuccessfulDeposit ─────────────────────────────────────────────────

export interface CompleteSuccessParams {
  /** PayU's own transaction reference, stored for reconciliation queries. */
  mihpayid: string;
}

/**
 * Finalises a successful deposit inside the caller's transaction.
 *
 * Steps (all within the caller-supplied `tx`):
 *  1. Updates `deposits` row: status → "success", mihpayId, payuTxnId,
 *     completedAt.
 *  2. Finds the user's Play Coins wallet account (FOR UPDATE within `tx`).
 *  3. Credits `deposit.coinsToCredit` via `recordCompletedTransaction`.
 *
 * Idempotency key: `payu_deposit:<deposit.id>` — `recordCompletedTransaction`
 * will throw on a duplicate insert, which rolls back the whole transaction.
 * However, callers must enforce the `status === "pending"` guard **before**
 * calling this function to avoid reaching the idempotency key as the primary
 * guard (it is a safety net, not the first line of defence).
 *
 * Throws:
 *  - `Error` if the user's Play Coins wallet account is not found.
 *    This causes the caller's transaction to roll back, leaving the deposit
 *    in its original `pending` state.
 */
export async function completeSuccessfulDeposit(
  tx: DbExecutor,
  deposit: Deposit,
  params: CompleteSuccessParams,
): Promise<void> {
  // Step 1 — write success state to the deposit row.
  await tx
    .update(depositsTable)
    .set({
      status: "success",
      mihpayId: params.mihpayid,
      // payuTxnId mirrors merchantOrderId; PayU echoes txnid in callbacks.
      payuTxnId: deposit.merchantOrderId,
      completedAt: new Date(),
    })
    .where(eq(depositsTable.id, deposit.id));

  // Step 2 — locate the Play Coins wallet.  Runs inside `tx` so the read is
  // consistent with the deposit row lock already held by the caller.
  const [playAccount] = await tx
    .select()
    .from(walletAccountsTable)
    .where(
      and(
        eq(walletAccountsTable.userId, deposit.userId),
        eq(walletAccountsTable.walletType, "play_coins"),
      ),
    );

  if (!playAccount) {
    // Throwing here causes the caller's transaction to roll back, undoing
    // the deposit UPDATE above.  The deposit reverts to "pending".
    throw new Error(
      `Play Coins wallet not found for user ${deposit.userId}. ` +
        `Cannot credit deposit ${deposit.id}. Transaction rolled back.`,
    );
  }

  // Step 3 — credit Play Coins.  recordCompletedTransaction acquires its own
  // FOR UPDATE lock on the wallet account, updates the cached balance, and
  // inserts the immutable ledger row — all inside `tx`.
  await recordCompletedTransaction(tx, {
    walletAccountId: playAccount.id,
    amount: deposit.coinsToCredit,
    referenceType: "payu_deposit",
    referenceId: deposit.id,
    idempotencyKey: `payu_deposit:${deposit.id}`,
    description: "PayU Deposit",
  });
}

// ── completeFailedDeposit ─────────────────────────────────────────────────────

export interface CompleteFailureParams {
  /**
   * Human-readable failure reason from the gateway (PayU field9, or a reason
   * derived from the Verify Payment API response).
   * Stored as-is; pass an empty string if unavailable (persisted as NULL).
   */
  failureReason: string;
}

/**
 * Finalises a failed deposit inside the caller's transaction.
 *
 * Steps (all within the caller-supplied `tx`):
 *  1. Updates `deposits` row: status → "failed", failureReason, completedAt.
 *
 * The wallet is never touched.
 */
export async function completeFailedDeposit(
  tx: DbExecutor,
  deposit: Deposit,
  params: CompleteFailureParams,
): Promise<void> {
  await tx
    .update(depositsTable)
    .set({
      status: "failed",
      // Store null instead of an empty string for missing failure reasons.
      failureReason: params.failureReason || null,
      completedAt: new Date(),
    })
    .where(eq(depositsTable.id, deposit.id));
}
