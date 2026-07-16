/**
 * Deposit reconciliation service — Phase 4.
 *
 * Recovers deposits whose PayU webhooks were never received.  Called by the
 * reconciliation scheduler (not yet implemented) for any deposit that has
 * remained `pending` beyond a configured threshold.
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 *   webhook path:           route handler → processPayUSuccess/Failure
 *                                         → completeSuccessfulDeposit ─┐
 *                                         → completeFailedDeposit      ─┤ shared
 *                                                                        │ service
 *   reconciliation path:    reconcileDeposit (this file)                │
 *                             → callPayUVerify                          │
 *                             → completeSuccessfulDeposit ──────────────┘
 *                             → completeFailedDeposit ─────────────────┘
 *
 *   The two paths share the same completion logic.  There is no duplicate
 *   wallet-credit or deposit-update code.
 *
 * ── HTTP call placement ───────────────────────────────────────────────────────
 *
 *   The PayU Verify API call happens OUTSIDE the DB transaction.
 *   Reason: holding a PostgreSQL row lock open during an HTTP round-trip
 *   (which can take 100 ms–5 s) would exhaust the connection pool under load
 *   and block concurrent webhooks for the same deposit.
 *
 *   Safety: the deposit row is locked again inside the transaction after the
 *   HTTP call returns.  The status is re-checked (idempotency guard) so any
 *   concurrent webhook that completed the deposit between the pre-check and
 *   the Verify call is detected and handled correctly.
 *
 * ── Atomicity guarantee ───────────────────────────────────────────────────────
 *
 *   The DB transaction (Step 3 onwards) guarantees:
 *     - deposit → "success" is never committed without the wallet credit.
 *     - wallet credit is never committed without deposit → "success".
 *
 *   This is enforced by completeSuccessfulDeposit (see deposit-completion.ts).
 */

import { eq } from "drizzle-orm";
import { db, depositsTable } from "@workspace/db";
import { logger } from "./logger";
import { callPayUVerify, PayUVerifyAPIError } from "./payu-verify";
import { completeSuccessfulDeposit, completeFailedDeposit } from "./deposit-completion";

// ── Result type ───────────────────────────────────────────────────────────────

/**
 * The outcome of a single reconciliation attempt.
 *
 * "resolved_success"  — deposit was pending; PayU confirms success.
 *                       deposit → "success", Play Coins credited.  COMMIT.
 *
 * "resolved_failure"  — deposit was pending; PayU confirms failure.
 *                       deposit → "failed", failureReason stored.  COMMIT.
 *                       Wallet untouched.
 *
 * "already_processed" — deposit was already "success" or "failed" before
 *                       this call.  No DB changes.  (Idempotent.)
 *
 * "ignored"           — no deposit row found for this merchantOrderId.
 *                       No DB changes.
 *
 * "still_pending"     — PayU also reports the transaction as pending.
 *                       No DB changes.  Caller should retry later.
 */
export type ReconcileResult =
  | "resolved_success"
  | "resolved_failure"
  | "already_processed"
  | "ignored"
  | "still_pending";

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Reconciles a single deposit by querying the PayU Verify Payment API and
 * updating the deposit row (and wallet, on success) if the transaction is
 * now finalised.
 *
 * @param merchantOrderId  The UUID sent to PayU as `txnid` during initiation.
 *
 * @throws {PayUVerifyAPIError}  If the Verify API call fails.  The deposit row
 *   is untouched — the caller should log the error and retry later.
 *
 * @throws {Error}  If amount validation fails (DB vs. PayU mismatch) or if the
 *   wallet account is missing.  The DB transaction rolls back, leaving the
 *   deposit `pending`.
 */
export async function reconcileDeposit(merchantOrderId: string): Promise<ReconcileResult> {
  // ── Step 1: Pre-check (no lock, no transaction) ───────────────────────────
  //
  // Fast path for the two cases that don't need a Verify API call at all.
  // We do NOT open a transaction here — the HTTP call in Step 2 must not
  // hold any DB connection or row lock.
  const [preCheck] = await db
    .select({
      id: depositsTable.id,
      status: depositsTable.status,
      amount: depositsTable.amount,
    })
    .from(depositsTable)
    .where(eq(depositsTable.merchantOrderId, merchantOrderId));

  if (!preCheck) {
    logger.warn({ merchantOrderId }, "Reconciliation: no deposit found; ignoring.");
    return "ignored";
  }

  if (preCheck.status !== "pending") {
    logger.info(
      { merchantOrderId, status: preCheck.status },
      "Reconciliation: deposit already processed; skipping.",
    );
    return "already_processed";
  }

  // ── Step 2: Call PayU Verify API (outside any DB transaction) ────────────
  //
  // Throws PayUVerifyAPIError on any API-level failure.
  // The caller is responsible for retry logic.
  const verifyResult = await callPayUVerify(merchantOrderId);

  if (verifyResult.outcome === "pending") {
    logger.info(
      { merchantOrderId },
      "Reconciliation: PayU reports transaction still pending; deferring.",
    );
    return "still_pending";
  }

  // ── Step 3: Finalise inside a DB transaction ──────────────────────────────
  //
  // We open the transaction only after the Verify API call returns.
  return await db.transaction(async (tx) => {
    // Re-acquire the deposit row with a FOR UPDATE lock.  This serialises any
    // concurrent webhook that may have arrived between Step 1 and Step 2.
    const [deposit] = await tx
      .select()
      .from(depositsTable)
      .where(eq(depositsTable.merchantOrderId, merchantOrderId))
      .for("update");

    // ── Guard: row disappeared (should never happen, defensive) ──────────
    if (!deposit) {
      logger.warn({ merchantOrderId }, "Reconciliation: deposit vanished between pre-check and lock.");
      return "ignored";
    }

    // ── Idempotency guard: a concurrent webhook may have completed this ────
    if (deposit.status !== "pending") {
      logger.info(
        { merchantOrderId, status: deposit.status },
        "Reconciliation: deposit completed by a concurrent webhook; skipping.",
      );
      return "already_processed";
    }

    // ── Amount guard: never credit a different amount than our DB record ───
    //
    // PayU sends amounts as decimal strings ("500.00").  Our DB stores rupees
    // as integers.  A mismatch indicates a corrupted or tampered response;
    // we throw to roll back and alert via the 500 log.
    const verifyAmount = parseFloat(verifyResult.amount);
    if (Math.abs(verifyAmount - deposit.amount) > 0.01) {
      throw new Error(
        `Reconciliation amount mismatch for deposit ${deposit.id}: ` +
          `DB has ₹${deposit.amount}, PayU Verify returned ₹${verifyResult.amount}. ` +
          `Refusing to complete deposit — transaction rolled back.`,
      );
    }

    // ── Delegate to shared completion service ─────────────────────────────
    if (verifyResult.outcome === "success") {
      await completeSuccessfulDeposit(tx, deposit, { mihpayid: verifyResult.mihpayid });
      logger.info(
        { merchantOrderId, depositId: deposit.id },
        "Reconciliation: deposit resolved as success; Play Coins credited.",
      );
      return "resolved_success";
    }

    // verifyResult.outcome === "failure"
    await completeFailedDeposit(tx, deposit, { failureReason: verifyResult.field9 });
    logger.info(
      { merchantOrderId, depositId: deposit.id },
      "Reconciliation: deposit resolved as failure.",
    );
    return "resolved_failure";
  });
}
