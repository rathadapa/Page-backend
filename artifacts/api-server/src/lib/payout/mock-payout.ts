/**
 * MockPayoutProvider — deterministic stub for integration tests.
 *
 * Behaviour is controlled by setting fields on the instance before each test.
 * All calls are recorded so tests can assert on what the service layer submitted.
 *
 * Usage:
 *
 *   const provider = new MockPayoutProvider();
 *   // Default: all submits accepted, verifications return 'success'.
 *
 *   // Make the next submitPayout reject:
 *   provider.nextSubmitResult = { outcome: 'rejected', reason: 'Invalid IFSC' };
 *
 *   // Make verifyPayout return pending then success:
 *   provider.verifyResults = [{ outcome: 'pending' }, { outcome: 'success', providerReference: 'REF' }];
 *
 *   // Inspect what was submitted:
 *   expect(provider.submittedPayouts).toHaveLength(1);
 *   expect(provider.submittedPayouts[0].amount).toBe(500);
 *
 *   // Parse a fabricated webhook:
 *   const event = provider.buildWebhookEvent('success', withdrawalId, 'REF_123');
 */

import type {
  PayoutProvider,
  PayoutWebhookEvent,
  SubmitPayoutInput,
  SubmitPayoutResult,
  VerifyPayoutResult,
} from "./provider";

export class MockPayoutProvider implements PayoutProvider {
  readonly name = "mock";

  // ── Submission control ───────────────────────────────────────────────────────

  /** Override to control the result of the NEXT submitPayout call. */
  nextSubmitResult: SubmitPayoutResult = {
    outcome: "accepted",
    providerReference: "",
  };

  /**
   * Auto-incrementing reference counter for accepted payouts.
   * Each accepted payout gets a unique reference: `MOCK_REF_1`, `MOCK_REF_2`, …
   */
  private _refCounter = 0;

  /** All inputs that were submitted via submitPayout, in call order. */
  submittedPayouts: SubmitPayoutInput[] = [];

  async submitPayout(input: SubmitPayoutInput): Promise<SubmitPayoutResult> {
    this.submittedPayouts.push(input);

    if (this.nextSubmitResult.outcome === "accepted") {
      this._refCounter += 1;
      const ref =
        this.nextSubmitResult.providerReference || `MOCK_REF_${this._refCounter}`;
      // Reset for next call unless overridden again.
      this.nextSubmitResult = { outcome: "accepted", providerReference: "" };
      return { outcome: "accepted", providerReference: ref };
    }

    // Return rejection and reset.
    const result = this.nextSubmitResult;
    this.nextSubmitResult = { outcome: "accepted", providerReference: "" };
    return result;
  }

  // ── Verification control ─────────────────────────────────────────────────────

  /**
   * Queue of results returned by successive verifyPayout calls.
   * Each call shifts one result from the front. When the queue is empty,
   * defaults to `{ outcome: 'success', providerReference: ref }` using the
   * providerReference argument passed to the call.
   */
  verifyResults: VerifyPayoutResult[] = [];

  /** All (providerReference, withdrawalId) pairs passed to verifyPayout. */
  verifiedPayouts: Array<{ providerReference: string; withdrawalId: string }> = [];

  async verifyPayout(
    providerReference: string,
    withdrawalId: string,
  ): Promise<VerifyPayoutResult> {
    this.verifiedPayouts.push({ providerReference, withdrawalId });

    const queued = this.verifyResults.shift();
    if (queued !== undefined) return queued;

    // Default: success with the reference we were given.
    return { outcome: "success", providerReference };
  }

  // ── Webhook helpers ──────────────────────────────────────────────────────────

  /**
   * Constructs the exact body object that `parseWebhook` expects for a success
   * or failure event. Use this in tests to simulate an inbound webhook.
   */
  buildWebhookEvent(
    outcome: "success" | "failure",
    withdrawalId: string,
    providerReference: string,
    reason?: string,
  ): Record<string, unknown> {
    return {
      _mock: true, // sentinel so parseWebhook knows this is from the mock
      outcome,
      withdrawalId,
      providerReference,
      reason: reason ?? "",
    };
  }

  parseWebhook(
    body: Record<string, unknown>,
    _headers: Record<string, string>,
  ): PayoutWebhookEvent | null {
    // Only accept events built by buildWebhookEvent.
    if (body["_mock"] !== true) return null;

    const withdrawalId = body["withdrawalId"];
    const providerReference = body["providerReference"];
    const outcome = body["outcome"];

    if (
      typeof withdrawalId !== "string" ||
      typeof providerReference !== "string" ||
      (outcome !== "success" && outcome !== "failure")
    ) {
      return null;
    }

    if (outcome === "success") {
      return { outcome: "success", providerReference, withdrawalId };
    }

    return {
      outcome: "failure",
      providerReference,
      withdrawalId,
      reason: typeof body["reason"] === "string" ? body["reason"] : "Unknown failure",
    };
  }

  // ── Test utilities ────────────────────────────────────────────────────────

  /** Resets all recorded calls and queued results. Useful in beforeEach. */
  reset(): void {
    this.submittedPayouts = [];
    this.verifiedPayouts = [];
    this.verifyResults = [];
    this.nextSubmitResult = { outcome: "accepted", providerReference: "" };
    this._refCounter = 0;
  }
}
