import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import {
  verifyReverseHash,
  processPayUSuccess,
  processPayUFailure,
  DepositNotFoundError,
  DepositAlreadyCompletedError,
} from "../lib/payu";

const router: IRouter = Router();

// ── Incoming webhook body schema ──────────────────────────────────────────────
// PayU POSTs callbacks as application/x-www-form-urlencoded.
// Express parses this via app.use(express.urlencoded({ extended: true })).
//
// All values are strings (URL-encoded form data is always strings).
// Optional fields default to "" so hash computation receives the same empty
// strings we originally sent to PayU.

const PayUCallbackBody = z.object({
  txnid: z.string().min(1),
  amount: z.string().min(1),
  productinfo: z.string(),
  firstname: z.string(),
  email: z.string(),
  status: z.string(),
  // SHA-512 hex is always exactly 128 characters.
  hash: z.string().length(128),
  mihpayid: z.string().default(""),
  key: z.string().min(1),
  udf1: z.string().default(""),
  udf2: z.string().default(""),
  udf3: z.string().default(""),
  udf4: z.string().default(""),
  udf5: z.string().default(""),
  // PayU stores the failure description in field9.
  field9: z.string().default(""),
});

type PayUCallbackBody = z.infer<typeof PayUCallbackBody>;

// ── Shared parse + verify helper ──────────────────────────────────────────────

/**
 * Parses the webhook body and verifies the PayU reverse hash.
 * Sends HTTP 400 and returns null on any failure.
 *
 * Logging contract:
 * - Logs only txnid (for correlation) on hash failure.
 * - NEVER logs PAYU_SALT, the computed hash, or the received hash.
 * - NEVER logs the full payload (which contains the user's email, etc.).
 */
async function parseAndVerify(req: Request, res: Response): Promise<PayUCallbackBody | null> {
  const parsed = PayUCallbackBody.safeParse(req.body);
  if (!parsed.success) {
    logger.warn("PayU callback: malformed body.");
    res.status(400).json({ message: "Malformed callback payload." });
    return null;
  }

  const body = parsed.data;

  // Read the salt at request time, consistent with how getPayUConfig() works
  // in the deposit lib.  Startup validation guarantees this is non-empty.
  const salt = process.env["PAYU_SALT"] ?? "";

  const valid = verifyReverseHash({
    salt,
    status: body.status,
    udf5: body.udf5,
    udf4: body.udf4,
    udf3: body.udf3,
    udf2: body.udf2,
    udf1: body.udf1,
    email: body.email,
    firstname: body.firstname,
    productinfo: body.productinfo,
    amount: body.amount,
    txnid: body.txnid,
    key: body.key,
    receivedHash: body.hash,
  });

  if (!valid) {
    // Log only txnid for correlation; never log the hash or salt.
    logger.warn({ txnid: body.txnid }, "PayU callback rejected: hash verification failed.");
    res.status(400).json({ message: "Hash verification failed." });
    return null;
  }

  return body;
}

// ── POST /payments/payu/success ───────────────────────────────────────────────

router.post("/payments/payu/success", async (req, res): Promise<void> => {
  const body = await parseAndVerify(req, res);
  if (!body) return;

  if (body.status !== "success") {
    logger.warn(
      { txnid: body.txnid, status: body.status },
      "PayU success URL received unexpected status.",
    );
    res.status(400).json({ message: "Unexpected status for this endpoint." });
    return;
  }

  try {
    await processPayUSuccess({ txnid: body.txnid, mihpayid: body.mihpayid });
    logger.info({ txnid: body.txnid }, "PayU deposit succeeded; Play Coins credited.");
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof DepositNotFoundError) {
      // Return 200 so PayU does not retry indefinitely.  Do not reveal
      // whether the txnid exists or ever existed.
      logger.warn({ txnid: body.txnid }, "PayU success callback for unknown txnid; ignoring.");
      res.status(200).json({ status: "ignored" });
      return;
    }
    if (err instanceof DepositAlreadyCompletedError) {
      logger.info({ txnid: body.txnid }, "PayU success callback: deposit already completed.");
      res.status(200).json({ ok: true });
      return;
    }
    throw err;
  }
});

// ── POST /payments/payu/failure ───────────────────────────────────────────────

router.post("/payments/payu/failure", async (req, res): Promise<void> => {
  const body = await parseAndVerify(req, res);
  if (!body) return;

  if (body.status !== "failure") {
    logger.warn(
      { txnid: body.txnid, status: body.status },
      "PayU failure URL received unexpected status.",
    );
    res.status(400).json({ message: "Unexpected status for this endpoint." });
    return;
  }

  try {
    await processPayUFailure({ txnid: body.txnid, failureReason: body.field9 });
    logger.info({ txnid: body.txnid }, "PayU deposit failed; status recorded.");
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof DepositNotFoundError) {
      // Return 200 so PayU does not retry indefinitely.  Do not reveal
      // whether the txnid exists or ever existed.
      logger.warn({ txnid: body.txnid }, "PayU failure callback for unknown txnid; ignoring.");
      res.status(200).json({ status: "ignored" });
      return;
    }
    if (err instanceof DepositAlreadyCompletedError) {
      logger.info({ txnid: body.txnid }, "PayU failure callback: deposit already completed.");
      res.status(200).json({ ok: true });
      return;
    }
    throw err;
  }
});

export default router;
