/**
 * Payout provider abstraction.
 *
 * The withdrawal business logic (withdrawal.ts, withdrawal-completion.ts,
 * withdrawal-submission.ts, withdrawal-reconciliation.ts) depends only on this
 * interface. All provider-specific logic (API calls, hash computation, response
 * parsing, webhook validation) lives in a concrete implementation.
 *
 * To swap providers: implement `PayoutProvider` in a new file and update the
 * factory function below. No business logic files need to change.
 *
 * Current implementations:
 *   PayUPayoutProvider  (payu-payout.ts)  — production
 *   MockPayoutProvider  (mock-payout.ts)  — integration tests
 */

// ── Input / result types ──────────────────────────────────────────────────────

/**
 * Input to a payout submission. The provider maps these fields to its own
 * API contract. The business layer never needs to know which fields the
 * provider requires.
 */
export interface SubmitPayoutInput {
  /**
   * Our withdrawal UUID. Sent to the provider as the merchant reference so
   * the webhook callback can be matched back to this withdrawal row.
   */
  withdrawalId: string;
  /**
   * Client-derived idempotency key for the provider API call. Prevents the
   * provider from double-paying if the submission job retries after a transient
   * network error. Derived as `withdrawal:{idempotencyKey}:submit`.
   */
  merchantReference: string;
  /** Whole rupees (1 Winning Coin = ₹1). */
  amount: number;
  bankAccountNumber: string;
  bankIfscCode: string;
  accountHolderName: string;
}

/**
 * Result of a `submitPayout` call.
 *
 * `accepted` — provider received the request and will settle asynchronously.
 *   The withdrawal should move to `processing`. `providerReference` is the
 *   provider's unique transaction ID for this payout.
 *
 * `rejected` — provider refused the request with a non-retriable error (e.g.
 *   invalid bank details, account blocked). The reservation must be released
 *   and the withdrawal marked `failed`.
 */
export type SubmitPayoutResult =
  | { outcome: "accepted"; providerReference: string }
  | { outcome: "rejected"; reason: string };

/**
 * Result of a `verifyPayout` call (used by the reconciliation job).
 *
 * `pending`  — provider has not settled yet; try again later.
 * `success`  — provider confirms successful credit to the bank account.
 * `failure`  — provider reports a permanent failure.
 */
export type VerifyPayoutResult =
  | { outcome: "pending" }
  | { outcome: "success"; providerReference: string }
  | { outcome: "failure"; reason: string };

/**
 * A parsed, validated payout webhook event. Returned by `parseWebhook` when
 * the payload is authentic and well-formed; `null` when validation fails.
 *
 * `withdrawalId` is our withdrawal UUID (the merchant reference we sent at
 * submission time, echoed back by the provider in the callback).
 */
export type PayoutWebhookEvent =
  | { outcome: "success"; providerReference: string; withdrawalId: string }
  | { outcome: "failure"; providerReference: string; withdrawalId: string; reason: string };

// ── Interface ─────────────────────────────────────────────────────────────────

export interface PayoutProvider {
  /**
   * Stable identifier stored on the `withdrawals.provider` column.
   * Allows historical records to be associated with the correct provider
   * even after a provider switch.
   */
  readonly name: string;

  /**
   * Submits a payout to the external provider.
   *
   * **Must be called OUTSIDE any DB transaction.**
   * Holding a Postgres row lock open during an HTTP round-trip exhausts the
   * connection pool under load and blocks concurrent operations on the same
   * wallet. The submission job releases its lock before calling this method.
   *
   * Returns immediately — does not wait for the bank credit to settle.
   * Settlement is signalled by a webhook callback or a `verifyPayout` poll.
   *
   * Throws on network error or non-200 HTTP response. The caller treats these
   * as transient and retries on the next job run.
   */
  submitPayout(input: SubmitPayoutInput): Promise<SubmitPayoutResult>;

  /**
   * Queries the provider for the current status of a previously submitted payout.
   * Used by the reconciliation job for withdrawals stuck in `processing`.
   *
   * **Must be called OUTSIDE any DB transaction** (same reason as `submitPayout`).
   *
   * Throws on network error. The caller treats this as transient.
   */
  verifyPayout(providerReference: string, withdrawalId: string): Promise<VerifyPayoutResult>;

  /**
   * Validates an inbound webhook payload and extracts the payout outcome.
   *
   * Called **synchronously** in the webhook route handler, before any DB work.
   * Must not perform any I/O — only hash verification and field extraction.
   *
   * Returns `null` when:
   *   - the signature/hash is invalid or missing
   *   - required fields are absent or malformed
   *
   * The route handler returns HTTP 400 when this method returns `null`.
   */
  parseWebhook(
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): PayoutWebhookEvent | null;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Resolves the active payout provider from the `PAYOUT_PROVIDER` environment
 * variable and the provider registry. Throws if the named provider is not
 * registered.
 *
 * Callers (route setup, background jobs) call this once at startup and pass
 * the resolved provider instance into the service functions. This avoids
 * re-reading env vars on every request and makes the provider injectable in
 * tests.
 *
 * @param overrideProviders — optional map used in tests to inject mock providers
 *   without setting environment variables.
 */
export function resolvePayoutProvider(
  overrideProviders?: Record<string, PayoutProvider>,
): PayoutProvider {
  const name = process.env["PAYOUT_PROVIDER"] ?? "payu";

  if (overrideProviders?.[name]) {
    return overrideProviders[name]!;
  }

  // Lazy-import concrete providers so the factory does not load provider SDKs
  // until they are actually needed. This keeps test startup fast when the test
  // uses MockPayoutProvider directly.
  if (name === "payu") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PayUPayoutProvider } = require("./payu-payout") as {
      PayUPayoutProvider: new () => PayoutProvider;
    };
    return new PayUPayoutProvider();
  }

  throw new Error(
    `Unknown payout provider "${name}". ` +
      `Set PAYOUT_PROVIDER to a registered provider name (currently: "payu").`,
  );
}
