# Withdrawal Module — Phase 1: Architecture & Database Design

> Design-only document. No code, no migrations, no APIs.
> All implementation is blocked on explicit approval of this design.

---

## 0. Existing Architecture Constraints (Non-Negotiable)

These rules are drawn from the existing codebase and must be respected without exception:

| Constraint | Source |
|---|---|
| `wallet_transactions` is append-only and immutable — no status field, no updates | `schema/wallets.ts` comment |
| `recordCompletedTransaction` is called **only when a balance change is final** | `lib/wallet.ts` comment |
| Balance debit must happen inside a `db.transaction()` with a `FOR UPDATE` lock on the wallet account | `lib/wallet.ts: recordCompletedTransaction` |
| The DB-level `CHECK (balance >= 0)` on `wallet_accounts` is the last-resort backstop against negative balances | `schema/wallets.ts` |
| `InsufficientBalanceError` is thrown (and the transaction rolled back) if a debit would make the balance negative | `lib/wallet.ts` |
| `reversalOfTransactionId` already exists on `wallet_transactions` for correcting entries | `schema/wallets.ts` |
| Only `winning_coins` accounts can be withdrawn; `play_coins` cannot | `schema/wallets.ts` comment |
| 1 coin = ₹1; all amounts are whole integers | `schema/wallets.ts`, `schema/deposits.ts` |

---

## 1. Proposed Database Tables

### 1.1 `user_bank_accounts`

Stores the bank/UPI destinations a user has registered for withdrawals. Kept separate from `withdrawals` so users can save multiple destinations and reuse them without re-entering details each time. The admin panel can audit all registered bank accounts per user without querying individual withdrawals.

```
user_bank_accounts
──────────────────────────────────────────────────────────────────
id                 uuid          PK, default random
userId             uuid          NOT NULL, FK → users.id ON DELETE RESTRICT
method             enum          NOT NULL  ('bank_transfer' | 'upi')
accountHolderName  text          NOT NULL
accountNumber      text          nullable  — populated when method = 'bank_transfer'
                                           stored encrypted at rest;
                                           only last 4 digits exposed to API consumers
ifscCode           text          nullable  — populated when method = 'bank_transfer'
upiId              text          nullable  — populated when method = 'upi'
isVerified         boolean       NOT NULL, default false
                                           — reserved for future KYC/penny-drop verification;
                                           no implementation now, but schema must not
                                           require a migration to add it
isActive           boolean       NOT NULL, default true
                                           — soft-delete; never hard-delete a row
                                           that is referenced by a withdrawal
createdAt          timestamptz   NOT NULL, default now()
updatedAt          timestamptz   NOT NULL, default now()

CONSTRAINTS
  CHECK (
    (method = 'bank_transfer' AND accountNumber IS NOT NULL AND ifscCode IS NOT NULL)
    OR
    (method = 'upi' AND upiId IS NOT NULL)
  )

INDEXES
  (userId)                         — list a user's saved accounts
  (userId, isActive)               — filter to active accounts only
```

**Why every field exists:**

| Field | Reason |
|---|---|
| `userId` | Ownership — only the owning user (or admin) may initiate withdrawals to this account |
| `method` | Determines which downstream fields are required; PayU payout API requires different fields per method |
| `accountHolderName` | Required by PayU and regulators; must match the bank's registered name |
| `accountNumber` | NEFT/IMPS destination; stored encrypted, displayed masked |
| `ifscCode` | Required for bank routing; 11-character RBI standard code |
| `upiId` | Alternative payout destination (VPA); format: `handle@bank` |
| `isVerified` | Placeholder for penny-drop / KYC verification; prevents schema change when verification is added |
| `isActive` | Soft-delete so a deactivated account is not offered in the UI but can still be read for audit of past withdrawals |

---

### 1.2 `withdrawals`

One row per withdrawal request. The row is the source of truth for the withdrawal's lifecycle; the wallet ledger is the source of truth for balance changes.

```
withdrawals
──────────────────────────────────────────────────────────────────
id                      uuid          PK, default random

-- WHO and HOW MUCH
userId                  uuid          NOT NULL, FK → users.id ON DELETE RESTRICT
amount                  integer       NOT NULL, CHECK (amount > 0)
                                      Whole rupees (= coins debited, since 1:1).

-- SOURCE WALLET (denormalized)
winningCoinsAccountId   uuid          NOT NULL, FK → wallet_accounts.id ON DELETE RESTRICT
                                      Stored explicitly so audit queries never need to
                                      join back through users to find the right account,
                                      and so the link survives any future multi-wallet
                                      change without breaking old rows.

-- DESTINATION (snapshot at request time)
bankAccountId           uuid          NOT NULL, FK → user_bank_accounts.id ON DELETE RESTRICT
                                      Points to the user_bank_accounts row the user
                                      chose at the time of the request.
method                  enum          NOT NULL  ('bank_transfer' | 'upi')
accountHolderName       text          NOT NULL  snapshot of the name at request time
accountNumberLast4      text          NOT NULL  last 4 digits only (display token)
accountNumberEncrypted  text          NOT NULL  full encrypted value sent to PayU
                                      — or upiId, depending on method
ifscCode                text          nullable  snapshot
upiId                   text          nullable  snapshot

WHY SNAPSHOT?
  Bank details can change (user edits or deletes a saved account). The withdrawal row
  must permanently record what was sent to PayU, independent of future edits to
  user_bank_accounts. This is also the audit record regulators expect.

-- STATUS
status                  enum          NOT NULL, default 'requested'
                                      ('requested' | 'processing' | 'success'
                                       | 'failed' | 'cancelled')

-- WALLET DEBIT TRACKING
debitTransactionId      uuid          nullable, FK → wallet_transactions.id
                                      Set atomically when the debit ledger entry is
                                      written. NULL only before debit; never cleared
                                      once set. Lets audit queries join directly to the
                                      exact ledger row that moved the coins.

-- REFUND TRACKING
reversalTransactionId   uuid          nullable, FK → wallet_transactions.id
                                      Set when a refund credit is written (on failure
                                      or cancellation). NULL for pending/processing/success.
                                      Using reversalOfTransactionId on the wallet_transactions
                                      row links it back; this column links forward from
                                      the withdrawal for fast lookup.

-- PAYU PAYOUT TRACKING
payuTransferId          text          nullable, UNIQUE
                                      PayU's reference returned by the Payout API at
                                      the time we submit the transfer request.
                                      UNIQUE constraint: two withdrawals cannot be
                                      linked to the same PayU transfer (duplicate payout
                                      prevention).
payuPaymentId           text          nullable, UNIQUE
                                      PayU's confirmed payment ID received via webhook.
                                      A second webhook with the same payuPaymentId is
                                      a duplicate and can be rejected before any DB write.

-- FAILURE
failureReason           text          nullable
                                      Human-readable failure reason from PayU or internal
                                      validation. NULL for pending/success rows.

-- ADMIN / OPS
reviewedByAdminId       uuid          nullable
                                      ID of the admin user who last actioned this row
                                      (approved, cancelled, or noted). Not a FK to avoid
                                      coupling to a future admin_users table whose schema
                                      is not yet designed; validated at application layer.
adminNote               text          nullable
                                      Free-text note left by admin during review.

-- TIMESTAMPS (each status transition has its own column for analytics)
requestedAt             timestamptz   NOT NULL, default now()  — always = createdAt
processedAt             timestamptz   nullable  — set when status → 'processing'
completedAt             timestamptz   nullable  — set when status → 'success'|'failed'|'cancelled'

-- IDEMPOTENCY (client-supplied)
idempotencyKey          text          NOT NULL, UNIQUE
                                      Caller-supplied key (e.g. UUID from the mobile client).
                                      A duplicate submission with the same key returns the
                                      existing withdrawal row without creating a new one
                                      or double-debiting the wallet.

createdAt               timestamptz   NOT NULL, default now()
updatedAt               timestamptz   NOT NULL, default now()

CONSTRAINTS
  CHECK (amount > 0)
  CHECK (status IN ('requested','processing','success','failed','cancelled'))
  -- Ensure debit is recorded before processing or completion:
  CHECK (
    status = 'requested'
    OR debitTransactionId IS NOT NULL
  )

INDEXES
  (userId, status)                    — "my pending withdrawals" query; admin filter
  (userId, createdAt DESC)            — user history, newest first
  (status, createdAt)                 — ops/admin dashboard: queue of pending requests
  (payuTransferId)                    — webhook lookup by PayU reference
  (payuPaymentId)                     — webhook dedup by PayU payment ID
  (idempotencyKey)                    — already covered by UNIQUE constraint
  (debitTransactionId)                — audit: find withdrawal linked to a ledger row
```

**Why every field exists:**

| Field | Reason |
|---|---|
| `userId` | Ownership; every query filters by user first |
| `amount` | Whole rupees; the only source of truth for how much was (or will be) transferred |
| `winningCoinsAccountId` | Direct link to the exact wallet account debited; avoids join through users; future-proof if multiple winning wallets are ever added |
| `bankAccountId` | Points to the saved account chosen at request time; combined with the snapshot fields gives full audit |
| Snapshot fields | Immutable record of exactly what was sent to PayU, independent of future edits to `user_bank_accounts` |
| `status` | Drives all business logic; indexed for queue/history queries |
| `debitTransactionId` | Bidirectional link: `wallet_transactions.referenceId` → withdrawal, this column → ledger row; essential for reconciliation |
| `reversalTransactionId` | Fast forward-lookup from withdrawal to its refund entry |
| `payuTransferId` | Lookup key for PayU webhook matching; UNIQUE prevents two rows claiming the same payout |
| `payuPaymentId` | Duplicate webhook guard at the DB level |
| `failureReason` | Operator visibility; user-facing message derived from this |
| `reviewedByAdminId` | Admin panel audit trail without requiring a separate audit log table |
| `adminNote` | Admin free-text for internal ops communication |
| Timestamp columns | Granular timestamps enable per-stage analytics (time-to-process, time-to-complete) without replaying event logs |
| `idempotencyKey` | Mobile clients retry on network failure; prevents duplicate withdrawals and wallet double-debits |

---

### 1.3 Relationship Diagram

```
users
 │
 ├── wallet_accounts (play_coins)      [existing]
 │
 ├── wallet_accounts (winning_coins)   [existing]
 │    │
 │    └── wallet_transactions          [existing, immutable ledger]
 │         ▲           ▲
 │         │           │ reversalOfTransactionId
 │         │           │
 │    debitTransactionId  reversalTransactionId
 │         │
 └── withdrawals  ────────────► user_bank_accounts
                                    (method, snapshot fields)
```

---

## 2. Integration Points

### 2.1 Wallet

The withdrawal module is a consumer of the Wallet module — it never writes to wallet tables directly. It calls `recordCompletedTransaction` (already exists) for both the debit and any subsequent reversal.

| Event | Wallet call | Amount |
|---|---|---|
| Withdrawal requested | `recordCompletedTransaction` (debit) | `-amount` on `winning_coins` |
| Withdrawal failed | `recordCompletedTransaction` (credit reversal) | `+amount` on `winning_coins`, with `reversalOfTransactionId` set |
| Withdrawal cancelled (before processing) | `recordCompletedTransaction` (credit reversal) | `+amount` on `winning_coins`, with `reversalOfTransactionId` set |
| Withdrawal succeeded | No wallet call — coins were already debited at request time | — |

`wallet_transactions` rows created by withdrawals use:
- `referenceType: "withdrawal"` (free text, per existing convention)
- `referenceId: withdrawal.id`
- `idempotencyKey: "withdrawal_debit:<withdrawal.id>"` for the debit
- `idempotencyKey: "withdrawal_refund:<withdrawal.id>"` for any reversal

This follows the exact same pattern as `"payu_deposit:<deposit.id>"` established in `deposit-completion.ts`.

### 2.2 PayU

The withdrawal module calls the **PayU Payout / Transfer API** (distinct from the Verify Payment API used for deposit reconciliation). Key integration points:

- **Request**: We POST bank/UPI details + amount to PayU's payout endpoint; receive a `payuTransferId` in response. This call happens **outside** the DB transaction (same pattern as `callPayUVerify`).
- **Webhook**: PayU POSTs a callback with `payuPaymentId` and final status when the payout settles. The webhook handler updates `withdrawals.status` and stores `payuPaymentId`.
- **Security**: PayU payout API hash formula (sha512, exact fields TBD from official docs) computed at call time. `PAYU_KEY`/`PAYU_SALT` never logged.

The withdrawal module does **not** modify the deposit module's callback handling. PayU success/failure webhooks for withdrawals will arrive at a separate endpoint (`/payments/payu/payout-callback` or similar — endpoint design deferred to Phase 2).

### 2.3 Future Admin Panel

The schema is designed so the admin panel can:

- **List all withdrawals** — `status`, `amount`, `userId`, `createdAt` indexes cover all expected filter combinations
- **View a single withdrawal** — all audit fields (`reviewedByAdminId`, `adminNote`, `debitTransactionId`, `payuTransferId`) are in the row
- **Cancel a withdrawal** (before processing) — status transition + reversal ledger entry, no schema change required
- **Retry a failed payout** — new `payuTransferId` written on the same row; `payuPaymentId` remains unique per confirmed payout
- **View a user's bank accounts** — `user_bank_accounts` indexed by `userId`

The `reviewedByAdminId` is a UUID stored as plain text (not a FK) so the admin user model can be designed independently without requiring a schema migration to the `withdrawals` table.

### 2.4 Future Notifications

Every status transition writes a new timestamp column (`processedAt`, `completedAt`) and updates `status`. A notification service needs only to watch for rows where `status` changed; it can query by `(status, completedAt)` without additional columns. If a message-queue approach is used, the application layer publishes events on each transition; the schema carries no notification state.

### 2.5 Future Analytics

- Per-stage latency: `processedAt - requestedAt`, `completedAt - processedAt` available without event replay
- Failure rates: `COUNT(*) GROUP BY status, DATE(createdAt)`
- Method split: `GROUP BY method`
- Referral / tournament attribution: future modules can store their reference in `wallet_transactions.referenceType` / `referenceId`; the withdrawal row itself does not need additional columns

---

## 3. State Machine

### 3.1 States

| State | Meaning | Wallet debit applied? |
|---|---|---|
| `requested` | User submitted; debit applied atomically at creation | ✅ Yes |
| `processing` | Payout request sent to PayU; awaiting settlement | ✅ Yes (from `requested`) |
| `success` | PayU confirms funds delivered | ✅ Yes (no new change) |
| `failed` | PayU confirms payout failed; reversal credit issued | Debited then refunded |
| `cancelled` | Cancelled (by user or admin) before `processing`; reversal credit issued | Debited then refunded |

### 3.2 Transition Diagram

```
                         ┌─── cancelled ───┐
                         │  (reversal)      │
                         │                  │
[user submits] ──► requested ──────────► processing ──► success
                  (debit here)                │
                                             └──► failed
                                                 (reversal)
```

### 3.3 Why debit at `requested` (not at `processing`)?

**Alternative considered:** debit at `processing`.
- **Problem:** there is a window between `requested` and `processing` during which the user's Winning Coins balance still shows the full amount. A concurrent conversion or a second withdrawal request could consume the same coins, making it impossible to debit at `processing` without a balance check that races with concurrent requests.
- **Chosen approach:** debit at `requested`, atomically in the same transaction that creates the withdrawal row. The user's Winning Coins balance immediately reflects the withdrawal. If the withdrawal is cancelled or fails, a reversal credit restores the balance. This eliminates the double-spend window entirely and mirrors how deposit credit works (credit is atomic with the webhook processing).

### 3.4 Permitted Transitions

| From | To | Actor | Wallet effect |
|---|---|---|---|
| — | `requested` | User | Debit `amount` from winning_coins |
| `requested` | `processing` | System / scheduler | None |
| `requested` | `cancelled` | User or Admin | Reversal credit `+amount` |
| `processing` | `success` | PayU webhook | None |
| `processing` | `failed` | PayU webhook | Reversal credit `+amount` |
| `processing` | `cancelled` | Admin only (exceptional ops) | Reversal credit `+amount` |

Any other transition is illegal and must be rejected with an error.

---

## 4. Atomicity

Three elements must remain consistent at all times:

| Element | Source of truth |
|---|---|
| Withdrawal status | `withdrawals.status` |
| Wallet debit | `wallet_transactions` ledger row (debit) |
| PayU payout | `withdrawals.payuTransferId` / `payuPaymentId` |

### 4.1 At `requested` creation

One DB transaction:
1. `SELECT … FOR UPDATE` on the user's `winning_coins` wallet account.
2. Idempotency check: if a row with this `idempotencyKey` already exists, return it (no writes).
3. `INSERT INTO withdrawals (status='requested', …)`.
4. `recordCompletedTransaction` — writes the debit ledger row and updates `wallet_accounts.balance`.
5. `UPDATE withdrawals SET debitTransactionId = <new ledger row id>`.
6. COMMIT.

The `CHECK (status = 'requested' OR debitTransactionId IS NOT NULL)` constraint makes it impossible to commit a `processing` or later row without a linked debit, providing a DB-level backstop.

### 4.2 At `requested` → `processing`

1. DB transaction: `SELECT … FOR UPDATE` on the withdrawal row; verify `status = 'requested'`; set `status = 'processing'`, `processedAt = now()`. COMMIT.
2. **Outside the transaction**: call PayU Payout API. Store `payuTransferId` in a subsequent UPDATE. If the API call fails, the row stays `processing` and the scheduler retries (see §5).

The PayU API call must happen outside the DB transaction, for the same reason stated in `reconciliation.ts`: holding a row lock during an HTTP call would exhaust the connection pool under load.

### 4.3 At `processing` → `success`

PayU webhook handler:
1. Validate webhook signature.
2. DB transaction: `SELECT … FOR UPDATE` on the withdrawal row; verify `status = 'processing'`; verify `payuTransferId` matches; write `payuPaymentId`, set `status = 'success'`, `completedAt = now()`. COMMIT.
3. No wallet change needed — coins were debited at creation.

### 4.4 At `processing` → `failed`

PayU webhook handler:
1. Validate webhook signature.
2. DB transaction: `SELECT … FOR UPDATE` on withdrawal row; verify `status = 'processing'`; call `recordCompletedTransaction` to issue a reversal credit (linking `reversalOfTransactionId` to the original debit ledger row); set `status = 'failed'`, `failureReason`, `completedAt`, `reversalTransactionId`. COMMIT.

The reversal credit and the status update are in the same transaction. It is impossible for the balance to be restored without `status = 'failed'`, or for the status to be `failed` without the balance restored.

---

## 5. Idempotency

### 5.1 Duplicate withdrawal request (client retry)

The `idempotencyKey` unique constraint on `withdrawals` ensures that a retried submission (same client-supplied key) returns the existing row rather than creating a new one and double-debiting the wallet. The application layer performs this check before opening any transaction.

### 5.2 Duplicate PayU webhook

The `payuPaymentId` unique constraint ensures that a redelivered webhook cannot update the same row twice. The handler checks `payuPaymentId IS NULL` inside the `FOR UPDATE` lock before writing — any webhook that arrives after the first one that set `payuPaymentId` is a no-op.

### 5.3 PayU payout API retry (scheduler)

If the payout API call fails after the row is already `processing`:
- The scheduler retries the same API call.
- If PayU returns the same `payuTransferId` (idempotent API): normal flow continues.
- If PayU has no record of the transfer (timeout before PayU received it): call the API again; a new `payuTransferId` is stored, overwriting the failed attempt. The `payuTransferId` is not UNIQUE for this reason — only `payuPaymentId` (the confirmed outcome) is.

### 5.4 Wallet debit idempotency

`recordCompletedTransaction` with `idempotencyKey: "withdrawal_debit:<withdrawal.id>"` is idempotent by construction (existing code already handles this). A retry of the creation flow that somehow re-enters `recordCompletedTransaction` will find the existing ledger row and return it without double-debiting.

---

## 6. Rollback Behaviour

| Scenario | What happened | DB state after rollback |
|---|---|---|
| DB error during `requested` creation (any step) | Transaction rolls back automatically | No withdrawal row, no ledger row, balance unchanged |
| `InsufficientBalanceError` during debit | Transaction rolls back | No withdrawal row, balance unchanged |
| PayU Payout API call fails (network/timeout) | Row already `processing` (committed before API call); no wallet change | Row stays `processing`; scheduler retries; balance unchanged |
| PayU confirms failure via webhook | Reversal credit issued atomically with `status = 'failed'` | Balance restored, `status = 'failed'` |
| DB error during failure webhook processing | Transaction rolls back | Row stays `processing`; webhook retry will re-enter and find `status = 'processing'`; safe to reprocess |
| DB error during reversal credit | Transaction rolls back | Row stays `processing`/`failed` (pre-commit); balance unchanged; retry reprocesses cleanly via idempotency key on the reversal |
| User cancels before `processing` | Reversal credit issued atomically with `status = 'cancelled'` | Balance restored, `status = 'cancelled'` |

**Key invariant:** the combination of the `CHECK` constraint, `FOR UPDATE` locks, and per-operation idempotency keys means every failure scenario either leaves the state unchanged or leaves it in a known, retryable state. There is no scenario where money is lost (debited without a corresponding payout or refund) or doubled (paid out + refunded).

---

## 7. Security

### 7.1 Ownership

- Every withdrawal query must include `WHERE userId = <authenticated user's id>`. The application layer enforces this; the DB schema enforces it as a hard FK.
- `user_bank_accounts` are owned by a user; the application must verify `bankAccount.userId === session.userId` before allowing a withdrawal to that account.
- A user may never initiate a withdrawal to another user's bank account.

### 7.2 Tampering Prevention

- **Amount**: `withdrawals.amount` is written once at creation and never updated. The debit ledger row records the same amount independently. A discrepancy between `withdrawals.amount` and `wallet_transactions.amount` (absolute value) is a data integrity error detectable by a reconciliation query.
- **Destination**: bank details are snapshotted at creation from `user_bank_accounts`. They cannot be changed after the row is created.
- **Status transitions**: every transition checks the current status inside a `FOR UPDATE` lock, so a concurrent request cannot move the row into an illegal state.
- **PayU webhook**: the webhook signature must be verified (sha512, using `PAYU_SALT`) before any DB write. `PAYU_KEY`/`PAYU_SALT` are never logged.

### 7.3 Replay Prevention

- `payuPaymentId` unique constraint: a replayed PayU webhook carrying a previously seen `payuPaymentId` is rejected at the DB level (and caught at the application level before the transaction is opened).
- `idempotencyKey` unique constraint: a replayed client submission is returned as-is.

### 7.4 Duplicate Payout Prevention

- `payuTransferId` records the payout reference. Before calling the PayU Payout API, the system checks that the withdrawal row does not already have a `payuTransferId` (or that the one it has matches a prior attempt that needs retrying).
- `payuPaymentId` unique constraint: even if the API were somehow called twice, PayU would return the same `payuPaymentId` for the same transfer, and the unique constraint would make the second webhook a no-op.

### 7.5 Bank Account Security

- `accountNumber` is stored encrypted at rest; only `accountNumberLast4` is returned to API consumers for display.
- Raw account numbers are never logged.
- The encrypted value is decrypted only at the moment of the PayU API call, in memory, without ever writing it to a log.

---

## 8. Future Compatibility

### 8.1 Admin Panel (no schema change needed)

The admin panel can be built entirely on top of the existing schema:

| Admin capability | How |
|---|---|
| List all withdrawals with filters (status, date, amount) | `SELECT` with indexes on `(status, createdAt)` |
| View withdrawal detail with linked wallet transactions | Join `withdrawals → wallet_transactions` via `debitTransactionId`, `reversalTransactionId` |
| See which admin last actioned a row | `reviewedByAdminId`, `adminNote` |
| Cancel a pending withdrawal | Status transition + reversal credit (same logic as user cancellation) |
| View a user's saved bank accounts | Query `user_bank_accounts WHERE userId = ?` |
| Flag a suspicious withdrawal | `adminNote` field; `reviewedByAdminId` |
| Retry a failed payout | Update `status → 'processing'` + new PayU API call |

### 8.2 Notifications

No schema change needed. Notifications subscribe to withdrawal status changes. The `completedAt`, `processedAt` timestamps provide all the timing data a notification template needs.

### 8.3 Referral / Tournament

These modules credit `winning_coins` via `recordCompletedTransaction` (already the pattern). The withdrawal module is downstream of them — it debits whatever balance these modules have credited. No coupling required.

### 8.4 Analytics

Per-stage latency, method mix, success/failure rates, and per-user history are all queryable from `withdrawals` with its existing indexes. No event-sourcing table or additional analytics columns are required.

### 8.5 Multi-currency / Fractional Amounts

Currently 1 coin = ₹1 (integer). If this changes, the `CHECK (amount > 0)` constraint and the `bigint` column type are compatible with a wider numeric type without a destructive migration. This is consistent with the existing wallet design.

---

## 9. Open Questions

These are product decisions that cannot be made architecturally. **Implementation must not proceed until each is resolved.**

### 9.1 Minimum and Maximum Withdrawal Amounts

- What is the minimum withdrawal amount (e.g. ₹100)?
- What is the maximum per-request limit (e.g. ₹10,000)?
- Is there a daily/monthly cap per user?
- These affect validation logic and potentially schema (a daily-cap enforcement may need an aggregate query or a separate counter row).

### 9.2 Admin Review / Approval Gate

- Does every withdrawal go through admin approval before the payout is submitted to PayU?
- Or only withdrawals above a threshold (e.g. > ₹5,000)?
- If yes, an `approved` state is needed between `requested` and `processing`. If no, the transition from `requested` to `processing` can be automated.
- Who can approve? Is there a role model for admin users?

### 9.3 User Cancellation Window

- Can a user cancel their own withdrawal after submitting?
- Only while `requested`, or also while `processing`?
- If `processing` cancellation is allowed (exceptional ops case), the PayU payout may already be in flight — does the product accept that risk?

### 9.4 KYC / Bank Account Verification

- Is a penny-drop verification required before a bank account can receive a withdrawal?
- If yes, `user_bank_accounts.isVerified` is already in the schema; the verification flow is not yet designed.
- Is there a KYC document requirement (PAN card, Aadhaar) for withdrawals above ₹10,000 (TDS threshold)?

### 9.5 TDS (Tax Deducted at Source)

- Net winnings above ₹10,000 per financial year are subject to 30% TDS under Indian gaming tax law.
- Does the platform deduct TDS before processing the withdrawal (i.e. the user receives `amount - TDS`)?
- If yes, the `withdrawals` table needs `tdsAmount` and `netPayoutAmount` columns, and the PayU API call uses `netPayoutAmount`.
- This is a legal requirement, not a product choice — confirm with your tax/legal advisor before implementation.

### 9.6 Supported PayU Payout Methods

- Which methods does the platform's PayU account support for payouts: NEFT, IMPS, UPI, or all three?
- This determines what the `method` enum values should be and what fields are required.

### 9.7 Withdrawal Processing Trigger

- What triggers the `requested → processing` transition?
  - A scheduler that batches pending withdrawals on a schedule (e.g. every hour)?
  - An admin action?
  - Immediate / near-real-time on `requested`?
- This determines whether the Phase 2 implementation needs a scheduler, a queue, or neither.

### 9.8 Failure Retry Policy

- How many times should a failed PayU payout be retried before the withdrawal is marked `failed` and refunded?
- Is there a retry backoff policy?
- Who is notified when a withdrawal cannot be processed after retries?

### 9.9 User Bank Account Limit

- How many saved bank accounts may a user have?
- Is there a limit per method (e.g. max 2 bank accounts + 1 UPI)?

### 9.10 Reversal Display to User

- When a withdrawal fails or is cancelled and the coins are refunded, should the wallet transaction history show the original debit and the reversal separately, or should it be hidden from the user as if it never happened?
- The ledger is immutable so both rows will always exist; the question is only about what the UI exposes.

---

*End of Phase 1 design document. Awaiting approval before Phase 2 implementation begins.*
