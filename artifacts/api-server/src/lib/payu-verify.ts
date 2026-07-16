/**
 * PayU Verify Payment API client.
 *
 * Official API reference:
 *   https://docs.payu.in/docs/verification-api
 *
 * ── Request ───────────────────────────────────────────────────────────────────
 *
 *   POST https://info.payu.in/merchant/postservice.php?form=2
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   Fields:
 *     key      — PAYU_KEY
 *     command  — "verify_payment"
 *     var1     — merchantOrderId (txnid sent during initiation)
 *     hash     — sha512(key|command|var1|SALT)
 *
 * ── Response ──────────────────────────────────────────────────────────────────
 *
 *   {
 *     "status": 1,
 *     "msg": "Transaction Fetched Successfully",
 *     "transaction_details": {
 *       "<merchantOrderId>": {
 *         "mihpayid": "403993715523580",
 *         "txnid": "<merchantOrderId>",
 *         "transaction_amount": "500.00",
 *         "status": "success",        // "success" | "failure" | "pending" | …
 *         "field9": "No Error",
 *         …
 *       }
 *     }
 *   }
 *
 *   The Verify API response does NOT include a hash to verify on our side.
 *   Security is provided by:
 *     1. Our SHA-512 request hash proves the call originated from us.
 *     2. TLS (HTTPS) authenticates PayU's identity and protects transit.
 *     3. We validate txnid echo-back and amount against our DB record in
 *        reconciliation.ts before writing anything.
 *
 * ── Security contract ─────────────────────────────────────────────────────────
 *
 *   This module NEVER logs PAYU_KEY, PAYU_SALT, or computed hashes.
 *   Only the merchantOrderId (non-secret, a UUID we generated) is logged
 *   and only on error paths.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAYU_VERIFY_URL = "https://info.payu.in/merchant/postservice.php?form=2";
const PAYU_VERIFY_COMMAND = "verify_payment";

// ── Error type ────────────────────────────────────────────────────────────────

/**
 * Thrown when the Verify API call fails for any reason:
 *   - network error
 *   - non-200 HTTP status
 *   - unexpected response shape
 *   - API-level error (status !== 1)
 *   - txnid echo-back mismatch (response tamper guard)
 *
 * The caller (reconciliation.ts) treats this as a retriable transient error
 * and does NOT modify the deposit row.
 */
export class PayUVerifyAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayUVerifyAPIError";
  }
}

// ── Request hash ──────────────────────────────────────────────────────────────

/**
 * Computes the SHA-512 request hash for the Verify Payment API.
 *
 * Formula: sha512(key|command|var1|SALT)
 *
 * NEVER call this with logged arguments — key and salt are secrets.
 */
function computeVerifyHash(key: string, command: string, var1: string, salt: string): string {
  return createHash("sha512")
    .update([key, command, var1, salt].join("|"))
    .digest("hex");
}

// ── Response schema ───────────────────────────────────────────────────────────

/**
 * The relevant fields inside `transaction_details.<txnid>`.
 * PayU may return many additional fields; we only bind what we need.
 */
const TransactionDetailSchema = z.object({
  /** PayU's own internal transaction reference. */
  mihpayid: z.string(),
  /** Echo of the merchantOrderId we sent as var1. */
  txnid: z.string(),
  /**
   * Actual transaction amount as a decimal string, e.g. "500.00".
   * Field name per official Verify API documentation.
   */
  transaction_amount: z.string(),
  /** "success" | "failure" | "pending" | "bounced" | other gateway values */
  status: z.string(),
  /** Human-readable failure reason; empty string on success. */
  field9: z.string().default(""),
});

const PayUVerifyResponseSchema = z.object({
  /**
   * 1  = API call succeeded (transaction record found).
   * 0  = API call failed (invalid hash, unknown key, etc.).
   * -1 = Transaction not found.
   */
  status: z.number(),
  msg: z.string().optional(),
  transaction_details: z.record(z.string(), TransactionDetailSchema).optional(),
});

// ── Result types ──────────────────────────────────────────────────────────────

/**
 * Typed result returned when the Verify API call and all validations succeed.
 *
 * `outcome: "pending"` — PayU has not finalised the transaction yet; the
 *   caller should not write anything and should retry later.
 *
 * `outcome: "success"` | `"failure"` — PayU has a final status; the caller
 *   should finalise the deposit accordingly.
 */
export type PayUVerifyResult =
  | { outcome: "success"; mihpayid: string; field9: string; amount: string }
  | { outcome: "failure"; mihpayid: string; field9: string; amount: string }
  | { outcome: "pending"; amount: string };

// ── Client function ───────────────────────────────────────────────────────────

/**
 * Calls the PayU Verify Payment API for a single merchantOrderId and returns
 * a validated, typed result.
 *
 * @param merchantOrderId  The UUID sent to PayU as `txnid` during initiation.
 *
 * @throws {PayUVerifyAPIError}  On any API-level or validation failure.
 *   Callers must NOT write to the DB when this error is thrown.
 */
export async function callPayUVerify(merchantOrderId: string): Promise<PayUVerifyResult> {
  // Read at call time — consistent with how getPayUConfig() works.
  const key = process.env["PAYU_KEY"] ?? "";
  const salt = process.env["PAYU_SALT"] ?? "";

  if (!key || !salt) {
    throw new PayUVerifyAPIError("PAYU_KEY and PAYU_SALT are required for the Verify API.");
  }

  const hash = computeVerifyHash(key, PAYU_VERIFY_COMMAND, merchantOrderId, salt);

  // ── Send request ────────────────────────────────────────────────────────────
  let rawJson: unknown;
  try {
    const response = await fetch(PAYU_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        key,
        command: PAYU_VERIFY_COMMAND,
        var1: merchantOrderId,
        hash,
      }).toString(),
    });

    if (!response.ok) {
      throw new PayUVerifyAPIError(
        `PayU Verify API returned HTTP ${response.status} for merchantOrderId ${merchantOrderId}.`,
      );
    }

    rawJson = await response.json();
  } catch (err) {
    if (err instanceof PayUVerifyAPIError) throw err;
    // Network-level failure (DNS, timeout, connection refused, …).
    logger.warn(
      { merchantOrderId, err: err instanceof Error ? err.message : String(err) },
      "PayU Verify API: network error.",
    );
    throw new PayUVerifyAPIError(
      `Network error calling PayU Verify API for merchantOrderId ${merchantOrderId}.`,
    );
  }

  // ── Parse and validate ──────────────────────────────────────────────────────
  const parsed = PayUVerifyResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    logger.warn(
      { merchantOrderId },
      "PayU Verify API: response failed schema validation.",
    );
    throw new PayUVerifyAPIError("Malformed PayU Verify API response.");
  }

  const { data } = parsed;

  // status !== 1 means the API itself returned an error (bad key, bad hash, …).
  if (data.status !== 1) {
    throw new PayUVerifyAPIError(
      `PayU Verify API returned error status ${data.status}: ${data.msg ?? "no message"} ` +
        `(merchantOrderId: ${merchantOrderId}).`,
    );
  }

  // Extract the transaction detail for our merchantOrderId.
  const detail = data.transaction_details?.[merchantOrderId];
  if (!detail) {
    throw new PayUVerifyAPIError(
      `PayU Verify API: no transaction_details entry for merchantOrderId ${merchantOrderId}.`,
    );
  }

  // ── Tamper guard: verify txnid echo-back ────────────────────────────────────
  // PayU echoes back the txnid we sent.  A mismatch indicates a routing error
  // or a tampered response.
  if (detail.txnid !== merchantOrderId) {
    throw new PayUVerifyAPIError(
      `PayU Verify API: txnid echo-back mismatch — ` +
        `sent ${merchantOrderId}, received ${detail.txnid}.`,
    );
  }

  // ── Map to typed result ──────────────────────────────────────────────────────
  const { status, mihpayid, transaction_amount: amount, field9 } = detail;

  if (status === "success") {
    return { outcome: "success", mihpayid, field9, amount };
  }

  if (status === "failure") {
    return { outcome: "failure", mihpayid, field9, amount };
  }

  // "pending", "bounced", or any other non-final status — caller should retry.
  return { outcome: "pending", amount };
}
