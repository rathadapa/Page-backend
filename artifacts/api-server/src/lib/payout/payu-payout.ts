/**
 * PayU Transfer Money (Payouts) provider implementation.
 *
 * ── API reference ─────────────────────────────────────────────────────────────
 *
 *   PayU Transfer Money API documentation:
 *   https://docs.payu.in/docs/transfer-money-api
 *
 * ── submitPayout (make_transfer) ─────────────────────────────────────────────
 *
 *   POST https://uatdashboard.payu.in/api/admin          (UAT)
 *   POST https://dashboard.payu.in/api/admin             (production)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   Fields:
 *     key      — PAYU_PAYOUT_KEY
 *     command  — "make_transfer"
 *     var1     — JSON-encoded transfer details (see TransferRequest below)
 *     hash     — sha512(key|command|var1|PAYU_PAYOUT_SALT)
 *
 *   Success response: { status: 1, msg: "...", data: { transferId: "...", txnid: "..." } }
 *   Failure response: { status: 0, msg: "..." }
 *
 * ── verifyPayout (get_payout_status) ─────────────────────────────────────────
 *
 *   Same endpoint, command: "get_payout_status"
 *   var1: JSON-encoded { transferId: providerReference }
 *   hash: sha512(key|command|var1|PAYU_PAYOUT_SALT)
 *
 *   Response: { status: 1, data: { status: "success"|"failure"|"pending", ... } }
 *
 * ── Webhook callback (parseWebhook) ──────────────────────────────────────────
 *
 *   PayU POSTs to your configured callback URL with form-encoded fields:
 *     txnid         — our withdrawal UUID (merchant reference)
 *     status        — "success" | "failure"
 *     transferId    — PayU's unique transfer reference (providerReference)
 *     amount        — decimal amount string (e.g. "500.00")
 *     hash          — verification hash (see computeWebhookHash below)
 *
 *   Hash formula (PayU Transfer Money webhook):
 *     sha512(SALT|status|amount|txnid|key)
 *
 * ── Security contract ─────────────────────────────────────────────────────────
 *
 *   This module NEVER logs PAYU_PAYOUT_KEY, PAYU_PAYOUT_SALT, or computed
 *   hashes. Only non-secret identifiers (withdrawalId, transferId) are logged.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { logger } from "../logger";
import type {
  PayoutProvider,
  PayoutWebhookEvent,
  SubmitPayoutInput,
  SubmitPayoutResult,
  VerifyPayoutResult,
} from "./provider";

// ── Configuration ─────────────────────────────────────────────────────────────

const PAYU_PAYOUT_URLS = {
  test: "https://uatdashboard.payu.in/api/admin",
  production: "https://dashboard.payu.in/api/admin",
} as const;

type PayUPayoutEnv = keyof typeof PAYU_PAYOUT_URLS;

interface PayUPayoutConfig {
  key: string;
  salt: string;
  apiUrl: string;
}

function getPayUPayoutConfig(): PayUPayoutConfig {
  const key = process.env["PAYU_PAYOUT_KEY"];
  const salt = process.env["PAYU_PAYOUT_SALT"];
  const env = (process.env["PAYU_PAYOUT_ENV"] ?? "test") as PayUPayoutEnv;

  if (!key) throw new Error("PAYU_PAYOUT_KEY environment variable is required.");
  if (!salt) throw new Error("PAYU_PAYOUT_SALT environment variable is required.");
  if (!(env in PAYU_PAYOUT_URLS)) {
    throw new Error(`PAYU_PAYOUT_ENV must be "test" or "production", got "${env}".`);
  }

  return { key, salt, apiUrl: PAYU_PAYOUT_URLS[env] };
}

// ── Hash computation ──────────────────────────────────────────────────────────

/**
 * Computes the SHA-512 request hash for the PayU Payout API.
 * Formula: sha512(key|command|var1|salt)
 * NEVER log the arguments — key and salt are secrets.
 */
function computeRequestHash(
  key: string,
  command: string,
  var1: string,
  salt: string,
): string {
  return createHash("sha512")
    .update([key, command, var1, salt].join("|"))
    .digest("hex");
}

/**
 * Computes the expected SHA-512 hash for an inbound payout webhook.
 * Formula: sha512(salt|status|amount|txnid|key)
 *
 * NOTE: Verify this formula against the PayU Transfer Money API documentation
 * before going to production. The hash format may differ between PayU account
 * types or API versions.
 */
function computeWebhookHash(
  salt: string,
  status: string,
  amount: string,
  txnid: string,
  key: string,
): string {
  return createHash("sha512")
    .update([salt, status, amount, txnid, key].join("|"))
    .digest("hex");
}

// ── Request / response schemas ────────────────────────────────────────────────

/** Transfer details sent as JSON-encoded `var1` in the make_transfer request. */
interface TransferRequest {
  txnid: string;      // our withdrawal UUID (merchant reference)
  amount: string;     // decimal string, e.g. "500.00"
  purpose: string;    // description shown to recipient
  account_number: string;
  ifsc_code: string;
  name: string;       // account holder name
}

const MakeTransferResponseSchema = z.object({
  status: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      transferId: z.string(),
      txnid: z.string().optional(),
    })
    .optional(),
});

const GetPayoutStatusResponseSchema = z.object({
  status: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      status: z.string(), // "success" | "failure" | "pending" | …
      transferId: z.string().optional(),
    })
    .optional(),
});

const PayoutWebhookBodySchema = z.object({
  txnid: z.string(),
  status: z.string(),
  transferId: z.string(),
  amount: z.string(),
  hash: z.string(),
});

// ── PayUPayoutProvider ────────────────────────────────────────────────────────

export class PayUPayoutProvider implements PayoutProvider {
  readonly name = "payu";

  // ── submitPayout ────────────────────────────────────────────────────────────

  async submitPayout(input: SubmitPayoutInput): Promise<SubmitPayoutResult> {
    const { key, salt, apiUrl } = getPayUPayoutConfig();
    const command = "make_transfer";

    const transferRequest: TransferRequest = {
      txnid: input.withdrawalId, // withdrawal UUID echoed back in webhook as txnid
      amount: input.amount.toFixed(2),
      purpose: "Withdrawal payout",
      account_number: input.bankAccountNumber,
      ifsc_code: input.bankIfscCode,
      name: input.accountHolderName,
    };

    const var1 = JSON.stringify(transferRequest);
    const hash = computeRequestHash(key, command, var1, salt);

    let rawJson: unknown;
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ key, command, var1, hash }).toString(),
      });

      if (!response.ok) {
        throw new Error(
          `PayU Payout API returned HTTP ${response.status} for withdrawal ${input.withdrawalId}.`,
        );
      }

      rawJson = await response.json();
    } catch (err) {
      logger.warn(
        {
          withdrawalId: input.withdrawalId,
          err: err instanceof Error ? err.message : String(err),
        },
        "PayU submitPayout: network or HTTP error.",
      );
      // Re-throw: caller (submission job) treats this as a transient failure.
      throw err;
    }

    const parsed = MakeTransferResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new Error(
        `PayU Payout API: malformed make_transfer response for withdrawal ${input.withdrawalId}.`,
      );
    }

    const { data: responseData } = parsed;

    if (responseData.status !== 1 || !responseData.data?.transferId) {
      // Non-retriable rejection from PayU (bad account details, etc.)
      const reason = responseData.msg ?? "PayU rejected the transfer request.";
      logger.info(
        { withdrawalId: input.withdrawalId, reason },
        "PayU submitPayout: transfer rejected.",
      );
      return { outcome: "rejected", reason };
    }

    logger.info(
      {
        withdrawalId: input.withdrawalId,
        transferId: responseData.data.transferId,
      },
      "PayU submitPayout: transfer accepted.",
    );

    return { outcome: "accepted", providerReference: responseData.data.transferId };
  }

  // ── verifyPayout ────────────────────────────────────────────────────────────

  async verifyPayout(
    providerReference: string,
    withdrawalId: string,
  ): Promise<VerifyPayoutResult> {
    const { key, salt, apiUrl } = getPayUPayoutConfig();
    const command = "get_payout_status";

    const var1 = JSON.stringify({ transferId: providerReference });
    const hash = computeRequestHash(key, command, var1, salt);

    let rawJson: unknown;
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ key, command, var1, hash }).toString(),
      });

      if (!response.ok) {
        throw new Error(
          `PayU Payout verify API returned HTTP ${response.status} ` +
            `for transferId ${providerReference}.`,
        );
      }

      rawJson = await response.json();
    } catch (err) {
      logger.warn(
        {
          providerReference,
          withdrawalId,
          err: err instanceof Error ? err.message : String(err),
        },
        "PayU verifyPayout: network or HTTP error.",
      );
      throw err;
    }

    const parsed = GetPayoutStatusResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
      throw new Error(
        `PayU Payout verify API: malformed response for transferId ${providerReference}.`,
      );
    }

    const { data: responseData } = parsed;

    if (responseData.status !== 1 || !responseData.data) {
      throw new Error(
        `PayU Payout verify API error (status ${responseData.status}): ` +
          `${responseData.msg ?? "no message"} for transferId ${providerReference}.`,
      );
    }

    const transferStatus = responseData.data.status;

    if (transferStatus === "success") {
      return {
        outcome: "success",
        providerReference: responseData.data.transferId ?? providerReference,
      };
    }

    if (transferStatus === "failure") {
      return { outcome: "failure", reason: responseData.msg ?? "Transfer failed." };
    }

    // "pending", "processing", or any other non-terminal status.
    return { outcome: "pending" };
  }

  // ── parseWebhook ────────────────────────────────────────────────────────────

  parseWebhook(
    body: Record<string, unknown>,
    _headers: Record<string, string>,
  ): PayoutWebhookEvent | null {
    // Validate the expected fields are present and are strings.
    const parsed = PayoutWebhookBodySchema.safeParse(body);
    if (!parsed.success) {
      logger.warn({ reason: "schema_mismatch" }, "PayU payout webhook: body schema mismatch.");
      return null;
    }

    const { txnid, status, transferId, amount, hash: receivedHash } = parsed.data;

    // ── Signature verification ───────────────────────────────────────────
    // Read config at call time. If env vars are missing, reject the webhook
    // gracefully rather than throwing (which would cause a 500 to PayU).
    const key = process.env["PAYU_PAYOUT_KEY"];
    const salt = process.env["PAYU_PAYOUT_SALT"];

    if (!key || !salt) {
      logger.error(
        "PayU payout webhook: PAYU_PAYOUT_KEY or PAYU_PAYOUT_SALT not set — " +
          "cannot verify webhook signature.",
      );
      return null;
    }

    const expectedHash = computeWebhookHash(salt, status, amount, txnid, key);

    let signatureValid: boolean;
    try {
      const expectedBuf = Buffer.from(expectedHash, "utf8");
      const receivedBuf = Buffer.from(receivedHash, "utf8");
      signatureValid =
        expectedBuf.length === receivedBuf.length &&
        timingSafeEqual(expectedBuf, receivedBuf);
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      // Do NOT log the received hash — an invalid hash may leak attacker intent.
      logger.warn(
        { withdrawalId: txnid, transferId },
        "PayU payout webhook: signature verification failed.",
      );
      return null;
    }

    // txnid is the withdrawal UUID we sent as the merchant reference.
    const withdrawalId = txnid;

    if (status === "success") {
      logger.info(
        { withdrawalId, transferId },
        "PayU payout webhook: success event authenticated.",
      );
      return { outcome: "success", providerReference: transferId, withdrawalId };
    }

    if (status === "failure") {
      logger.info(
        { withdrawalId, transferId },
        "PayU payout webhook: failure event authenticated.",
      );
      return {
        outcome: "failure",
        providerReference: transferId,
        withdrawalId,
        reason: "PayU reported transfer failure.",
      };
    }

    // Any status other than "success" or "failure" is unrecognised.
    logger.warn(
      { withdrawalId, transferId, status },
      "PayU payout webhook: unrecognised status; ignoring.",
    );
    return null;
  }
}
