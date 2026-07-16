/**
 * Internal reconciliation route.
 *
 * Exposes the deposit reconciliation service as a callable HTTP endpoint for
 * internal use (e.g. a future scheduler or manual ops trigger).
 *
 * This endpoint is intentionally NOT guarded by requireSession because it is
 * called by internal infrastructure, not by user browsers.  It MUST NOT be
 * exposed to the public internet — callers are responsible for network-level
 * access control (VPC, firewall rules, etc.).
 *
 * POST /internal/reconcile
 *   Body: { merchantOrderId: string }
 *   200:  { result: ReconcileResult }
 *   400:  { message: string }         — malformed body
 *   500:  propagated by Express error handler — Verify API failure or DB error
 *         (deposit row is left pending; caller should retry)
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { reconcileDeposit } from "../lib/reconciliation";
import { PayUVerifyAPIError } from "../lib/payu-verify";

const router: IRouter = Router();

// ── Request schema ────────────────────────────────────────────────────────────

const ReconcileRequestBody = z.object({
  /**
   * The UUID sent to PayU as `txnid` during deposit initiation.
   * Stored in the deposits table as `merchant_order_id`.
   */
  merchantOrderId: z.string().uuid(),
});

// ── POST /internal/reconcile ──────────────────────────────────────────────────

router.post("/internal/reconcile", async (req, res): Promise<void> => {
  const parsed = ReconcileRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      message: "Invalid request body. `merchantOrderId` must be a valid UUID.",
    });
    return;
  }

  const { merchantOrderId } = parsed.data;

  try {
    const result = await reconcileDeposit(merchantOrderId);

    logger.info({ merchantOrderId, result }, "Reconciliation complete.");
    res.status(200).json({ result });
  } catch (err) {
    if (err instanceof PayUVerifyAPIError) {
      // Retriable transient error — deposit is unchanged (still pending).
      // Log with warn so ops can retry; do not swallow the error silently.
      logger.warn(
        { merchantOrderId, message: err.message },
        "Reconciliation: PayU Verify API error; deposit unchanged.",
      );
      // Re-throw so Express's error handler returns 500.  The deposit row was
      // not modified — the caller can safely retry.
      throw err;
    }

    // Any other error (amount mismatch, missing wallet) — transaction was
    // rolled back; deposit is still pending.
    logger.error(
      { merchantOrderId, err: err instanceof Error ? err.message : String(err) },
      "Reconciliation: unexpected error; transaction rolled back.",
    );
    throw err;
  }
});

export default router;
