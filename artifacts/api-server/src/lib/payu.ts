import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, depositsTable, type Deposit } from "@workspace/db";
import { completeSuccessfulDeposit, completeFailedDeposit } from "./deposit-completion";

// ── Custom error types (for flow control in route handlers) ───────────────────

export class DepositNotFoundError extends Error {
  constructor(txnid: string) {
    super(`No deposit found for txnid: ${txnid}`);
    this.name = "DepositNotFoundError";
  }
}

export class DepositAlreadyCompletedError extends Error {
  readonly deposit: Deposit;
  constructor(deposit: Deposit) {
    super(`Deposit ${deposit.id} is already ${deposit.status}.`);
    this.name = "DepositAlreadyCompletedError";
    this.deposit = deposit;
  }
}

// ── Reverse hash ──────────────────────────────────────────────────────────────

/**
 * Computes the PayU SHA-512 reverse hash used to validate incoming webhook
 * callbacks.
 *
 * Official formula (PayU documentation):
 *   sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 *
 * The 5 empty strings between `status` and `udf5` are the 5 trailing empty
 * positions from the forward hash, reversed.  All udf fields are empty strings
 * because we never populate them during initiation.
 *
 * @see https://docs.payu.in/docs/hashing-request-and-response
 */
export function computeReverseHash(params: {
  salt: string;
  status: string;
  udf5: string;
  udf4: string;
  udf3: string;
  udf2: string;
  udf1: string;
  email: string;
  firstname: string;
  productinfo: string;
  amount: string;
  txnid: string;
  key: string;
}): string {
  const parts = [
    params.salt,
    params.status,
    "", // trailing position 5 (reversed)
    "", // trailing position 4
    "", // trailing position 3
    "", // trailing position 2
    "", // trailing position 1
    params.udf5,
    params.udf4,
    params.udf3,
    params.udf2,
    params.udf1,
    params.email,
    params.firstname,
    params.productinfo,
    params.amount,
    params.txnid,
    params.key,
  ];
  return createHash("sha512").update(parts.join("|")).digest("hex");
}

/**
 * Verifies the PayU reverse hash from an incoming webhook.
 *
 * Uses constant-time comparison (timingSafeEqual) to prevent timing attacks.
 * Returns false for any malformed input rather than throwing.
 *
 * NEVER passes the salt or the expected hash to a logger.
 */
export function verifyReverseHash(params: {
  salt: string;
  status: string;
  udf5: string;
  udf4: string;
  udf3: string;
  udf2: string;
  udf1: string;
  email: string;
  firstname: string;
  productinfo: string;
  amount: string;
  txnid: string;
  key: string;
  receivedHash: string;
}): boolean {
  try {
    const { receivedHash, ...hashParams } = params;
    const expected = computeReverseHash(hashParams);

    const expectedBuf = Buffer.from(expected, "utf8");
    const receivedBuf = Buffer.from(receivedHash, "utf8");

    // Length mismatch means the received hash is malformed; timingSafeEqual
    // would throw if lengths differ, so guard here explicitly.
    if (expectedBuf.length !== receivedBuf.length) return false;

    return timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

// ── Success flow ──────────────────────────────────────────────────────────────

export interface PayUSuccessParams {
  txnid: string;
  mihpayid: string;
}

/**
 * Processes a PayU success callback atomically.
 *
 * Inside a single DB transaction:
 * 1. Locks the deposit row (FOR UPDATE) — serialises concurrent webhooks.
 * 2. Guards against already-completed deposits (idempotency).
 * 3. Delegates to `completeSuccessfulDeposit` for the DB writes + wallet
 *    credit (shared with the Phase 4 reconciliation job).
 * 4. Commits.  Any failure at any step rolls back everything.
 *
 * There is never a committed deposit with status=success without the
 * corresponding wallet credit, and vice versa.
 *
 * Throws:
 * - DepositNotFoundError          — no deposit matches txnid
 * - DepositAlreadyCompletedError  — deposit is not pending (idempotency)
 * - Error                         — internal failure; triggers rollback → 500
 */
export async function processPayUSuccess(params: PayUSuccessParams): Promise<void> {
  await db.transaction(async (tx) => {
    // Step 1 — acquire row lock.  A second concurrent webhook for the same
    // txnid will block here until the first transaction commits, then will
    // see status !== "pending" and exit via DepositAlreadyCompletedError.
    const [deposit] = await tx
      .select()
      .from(depositsTable)
      .where(eq(depositsTable.merchantOrderId, params.txnid))
      .for("update");

    if (!deposit) {
      throw new DepositNotFoundError(params.txnid);
    }

    // Step 2 — idempotency guard (runs after the lock for a consistent read).
    if (deposit.status !== "pending") {
      throw new DepositAlreadyCompletedError(deposit);
    }

    // Step 3 — shared completion logic (also used by the reconciliation job).
    await completeSuccessfulDeposit(tx, deposit, { mihpayid: params.mihpayid });

    // Step 4 — implicit COMMIT when the callback returns without throwing.
  });
}

// ── Failure flow ──────────────────────────────────────────────────────────────

export interface PayUFailureParams {
  txnid: string;
  failureReason: string;
}

/**
 * Processes a PayU failure callback atomically.
 *
 * Inside a single DB transaction:
 * 1. Locks the deposit row.
 * 2. Guards against already-completed deposits (idempotency).
 * 3. Delegates to `completeFailedDeposit` for the DB write (shared with the
 *    Phase 4 reconciliation job).
 * 4. Commits.  The wallet is never touched.
 *
 * Throws:
 * - DepositNotFoundError          — no deposit matches txnid
 * - DepositAlreadyCompletedError  — deposit is not pending (idempotency)
 */
export async function processPayUFailure(params: PayUFailureParams): Promise<void> {
  await db.transaction(async (tx) => {
    const [deposit] = await tx
      .select()
      .from(depositsTable)
      .where(eq(depositsTable.merchantOrderId, params.txnid))
      .for("update");

    if (!deposit) {
      throw new DepositNotFoundError(params.txnid);
    }

    if (deposit.status !== "pending") {
      throw new DepositAlreadyCompletedError(deposit);
    }

    // Shared completion logic (also used by the reconciliation job).
    await completeFailedDeposit(tx, deposit, { failureReason: params.failureReason });

    // Implicit COMMIT when the callback returns without throwing.
  });
}
