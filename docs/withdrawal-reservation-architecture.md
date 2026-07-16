# Withdrawal Module — Reserved / Locked Funds Architecture Evaluation

> Architecture review only. No implementation, no migrations, no code.
> Awaiting approval before any work proceeds.

---

## 0. The Problem Statement

The Phase 1 design permanently debits Winning Coins at withdrawal request time and issues a reversal credit on failure. This works but has one material weakness: the wallet ledger shows a debit even for withdrawals that never settle, creating noise in the audit trail and making the ledger harder to reconcile (every row is "real" money moved, but debit+reversal pairs are not real movements — they are temporary holds that unwound).

The request is to evaluate whether a **reservation / locked funds** model is a better fit — one where coins are held (but not debited) when a withdrawal is requested, and only permanently debited when the withdrawal succeeds.

---

## 1. Existing Architecture — What Must Be Preserved

Drawn from the codebase. These are constraints, not preferences.

| Invariant | Where enforced |
|---|---|
| `wallet_transactions` is append-only; no row is ever updated or deleted | Schema comment, no `status` column |
| `recordCompletedTransaction` is called **only for final, settled balance changes** | `lib/wallet.ts` doc comment |
| Every balance mutation happens under a `FOR UPDATE` row lock on `wallet_accounts` | `lib/wallet.ts: recordCompletedTransaction` |
| `CHECK (balance >= 0)` at the DB level is the last-resort backstop | `schema/wallets.ts` |
| `balance` on `wallet_accounts` is a denormalized cache of the ledger sum, kept in sync inside the same transaction as each ledger insert | Schema comment |
| `reversalOfTransactionId` on `wallet_transactions` links a correcting entry to what it reverses | `schema/wallets.ts` |

The evaluation must score each approach against these constraints.

---

## 2. The Four Approaches

---

### Approach A — `locked_balance` Column on `wallet_accounts`

Add a single `locked_balance` (or `reserved_balance`) integer column to the existing `wallet_accounts` table.

```
wallet_accounts (modified)
  balance          bigint  — total balance including reserved coins  [existing]
  reserved_balance bigint  — coins currently locked                 [NEW]

  available_balance = balance - reserved_balance  (computed, not stored)

  CHECK (balance >= 0)          [existing]
  CHECK (reserved_balance >= 0) [NEW]
  CHECK (balance >= reserved_balance) [NEW]
```

**Lifecycle:**

| Event | DB operation |
|---|---|
| Reserve (withdrawal requested) | `FOR UPDATE` on wallet account; verify `balance - reserved_balance >= amount`; `reserved_balance += amount` |
| Confirm (withdrawal succeeds) | `FOR UPDATE`; `recordCompletedTransaction` (debit: `-amount`); `reserved_balance -= amount`; `balance -= amount` |
| Release (withdrawal fails/cancels) | `FOR UPDATE`; `reserved_balance -= amount` |

**Advantages:**

- Minimal schema change — one column added to one existing table.
- Fast: `available_balance` computed inline as `balance - reserved_balance`; no JOIN required.
- No new tables; fits the existing query patterns.
- The `FOR UPDATE` locking pattern already used by `recordCompletedTransaction` serialises all concurrent operations correctly.

**Disadvantages:**

- **No audit trail of individual reservations.** `reserved_balance = 1500` tells you that 1500 coins are locked but not which withdrawal(s) locked them, when, or why. A bug that corrupts `reserved_balance` has no recovery path — you cannot reconcile it against any other table.
- **Does not support multiple concurrent hold types.** If tournaments later need to hold coins, and admin fraud holds need to hold coins, `reserved_balance` becomes a sum of unrelated holds. You cannot release just the withdrawal hold without risking releasing a tournament hold.
- **One column per hold type, or nothing.** The only way to distinguish withdrawal holds from tournament holds is additional columns (`withdrawal_reserved`, `tournament_reserved`, `fraud_hold`, …). This is an anti-pattern — schema changes are required every time a new hold type is added.
- **No per-reservation lifecycle.** There is no record of when a reservation was created, by what, or what happened to it. The admin panel cannot show "this user has a pending withdrawal hold of ₹500."
- **Silent corruption risk.** If the application crashes between updating `reserved_balance` and updating the `withdrawals` row, the two tables are inconsistent. There is no row-level evidence of the crash — only a global numeric discrepancy.

**Verdict:** Acceptable only for a single, simple hold type with no audit requirements and no future extensibility needs. Fails the auditability and scalability requirements here.

---

### Approach B — `wallet_reservations` Table (Mutable, Status-Based)

A separate table where each hold is a row with a mutable `status` column.

```
wallet_reservations
  id               uuid         PK
  walletAccountId  uuid         FK → wallet_accounts.id
  amount           bigint       NOT NULL, CHECK > 0
  status           enum         NOT NULL  ('active' | 'confirmed' | 'released')
  reasonType       text         NOT NULL  ('withdrawal' | 'tournament_entry' | 'admin_hold' | …)
  reasonId         uuid         NOT NULL  — FK to the owning entity (withdrawals.id, etc.)
  idempotencyKey   text         NOT NULL, UNIQUE
  createdAt        timestamptz  NOT NULL
  updatedAt        timestamptz  NOT NULL

  INDEX (walletAccountId, status)
  INDEX (reasonType, reasonId)
```

Available balance = `wallet_accounts.balance - SUM(wallet_reservations.amount WHERE status = 'active')`.

To avoid the JOIN on every balance read, combine with a denormalized `reserved_balance` column on `wallet_accounts` (same as Approach A's column, but now it has a reconcilable source of truth in `wallet_reservations`).

**Lifecycle:**

| Event | DB operation |
|---|---|
| Reserve | `FOR UPDATE` on wallet account; verify `balance - reserved_balance >= amount`; INSERT reservation row (`status = 'active'`); `reserved_balance += amount` on wallet account |
| Confirm | `FOR UPDATE` on wallet account; UPDATE reservation `status → 'confirmed'`; `recordCompletedTransaction` (debit: `-amount`); `reserved_balance -= amount`; `balance -= amount` |
| Release | `FOR UPDATE` on wallet account; UPDATE reservation `status → 'released'`; `reserved_balance -= amount` |

**Advantages:**

- **Per-reservation audit trail.** Every hold is a named row — you can query "show me all active holds for this user," "what is this ₹500 reservation for," "when was this hold created and when was it released."
- **Multiple hold types are first-class.** `reasonType` distinguishes withdrawals, tournament entries, admin holds, fraud holds. Each is independently manageable.
- **Reconcilable.** `reserved_balance` on `wallet_accounts` can be cross-checked at any time against `SUM(active reservations)`. A discrepancy is detectable and correctable.
- **Admin panel ready.** A single query on `wallet_reservations WHERE status = 'active'` shows all active holds across the platform.
- **`wallet_transactions` remains completely unchanged.** The immutable ledger is called only at settlement, exactly as designed.

**Disadvantages:**

- **Reservation rows are mutable** (`status` changes from `active` to `confirmed` or `released`). This is a departure from the immutable-ledger philosophy — the reservation table is not an audit log, it is a state machine.
- **Status-based logic requires careful transition guards.** The application must enforce legal transitions (`active → confirmed`, `active → released`; never `confirmed → released`). This is application-level logic, not DB-level.
- **Lock ordering matters.** When acquiring `FOR UPDATE` on the wallet account, the reservation row must also be locked in the correct order to avoid deadlocks with concurrent operations. This is solvable but must be explicitly documented.
- **Historical reservations are queryable but immutably "done."** You can see that a reservation was `released`, but not the intermediate state history (was it ever partially released?). For most use cases this is sufficient.

**Verdict:** Strong fit. Meets all stated requirements. Used by most mid-size payment platforms. The key weakness (mutable status) is mitigated by the fact that the reservation table is not the financial ledger — it is an operational state tracker, and mutable state is appropriate for operational records.

---

### Approach C — Append-Only Reservation Ledger

A parallel immutable ledger for reservations, modelled exactly like `wallet_transactions`. Every hold lifecycle event is an immutable row; the current active reservation amount is derived by aggregation.

```
wallet_reservation_events
  id               uuid         PK
  walletAccountId  uuid         FK → wallet_accounts.id
  eventType        enum         ('hold_created' | 'hold_confirmed' | 'hold_released')
  amount           bigint       NOT NULL, CHECK > 0
  reservationId    uuid         NOT NULL  — groups events belonging to one hold
  reasonType       text         NOT NULL
  reasonId         uuid         NOT NULL
  idempotencyKey   text         NOT NULL, UNIQUE
  createdAt        timestamptz  NOT NULL
```

Active reservation for a wallet = `SUM(amount) WHERE eventType = 'hold_created'` minus `SUM(amount) WHERE eventType IN ('hold_confirmed', 'hold_released')`.

Combined with `reserved_balance` on `wallet_accounts` as a denormalized cache of the above aggregate.

**Advantages:**

- **Fully immutable audit trail.** Every state transition is a permanent, timestamped row. No row is ever updated. The full history of every reservation is provable by replaying the event log.
- **Philosophically consistent** with the existing `wallet_transactions` design — both ledgers are append-only and truth-by-aggregation.
- **Forensic-grade auditability.** You can prove exactly when a hold was created, when it was released, and by which process — down to the millisecond.
- **No lost history.** Approach B shows you the final state of a reservation; this approach shows you the full state history.

**Disadvantages:**

- **Significant complexity increase.** Querying "is this reservation still active?" requires either an aggregation query or a join on reservation events, rather than a single row lookup.
- **Aggregate queries are expensive at scale without materialisation.** At 1 million reservations with 3 events each, computing active holds requires scanning 3 million rows unless `reserved_balance` is faithfully maintained (which it must be — same denormalized column as Approach A/B).
- **The existing `wallet_transactions` does not take this approach for completed transactions either.** The ledger has `balanceAfter` as a running snapshot specifically to avoid replaying. Adopting a pure event-sourcing approach for reservations while keeping a snapshot-based approach for the ledger creates an architectural inconsistency.
- **Overkill for this use case.** The full event history is valuable for regulatory audit of completed balance changes. For operational reservation tracking (which holds are active right now, and why), a mutable status column (Approach B) is both sufficient and simpler.
- **Implementation surface area.** Every component that needs to know the active reservation state must either trust the `reserved_balance` cache (same risk as Approach A) or aggregate — there is no simple, cheap "what is the current state of reservation X?" query.

**Verdict:** Ideal for a pure event-sourcing architecture built from the ground up. Not a good fit here — the existing system is not event-sourced, and adding an event-sourced reservation ledger alongside a snapshot-based transaction ledger creates two different architectural philosophies in the same wallet module. The auditability gain over Approach B is marginal for operational reservation tracking.

---

### Approach D — Two-Phase Ledger Entries (Pending Entries in `wallet_transactions`)

Add a `status` field to `wallet_transactions`: `pending` (hold) and `posted` (settled). The `balance` column on `wallet_accounts` reflects only `posted` entries. Available balance = balance (posted) minus sum of pending entries.

**This approach is evaluated for completeness but is not viable here.**

The existing schema comment is explicit:

> *"Append-only ledger. Every row is immutable once written — there is no status field, because the Wallet module only records completed balance changes."*

And `lib/wallet.ts`:

> *"Pending/failed/retry states for deposits, payouts, or tournament settlement belong to the modules that own those workflows; they call into Wallet only once a change is final."*

Adding a `status` field to `wallet_transactions` would:
- Require an ALTER TABLE on a live, high-write table
- Break every query that reads `wallet_transactions` and assumes all rows are final
- Break `balanceAfter` — a pending entry's `balanceAfter` is not the true balance after settlement
- Break `recordCompletedTransaction` — its caller contract ("call only when final") would have to change
- Require all existing consumers (`deposit-completion.ts`, `payu.ts`, `wallet.ts`) to be audited and updated

**Verdict:** Rejected. Incompatible with the existing architecture. Would require a redesign of the entire wallet module.

---

## 3. What Large Fintech and Payment Systems Use

### Stripe

Stripe models holds as **PaymentIntent authorisations** — a separate object from the settled charge. An authorisation creates a hold on the customer's card (tracked in the `PaymentIntent` object with `status: requires_capture`). A capture settles it and creates a `Charge` record in the financial ledger. The `Charge` (final, settled) is the ledger entry; the `PaymentIntent` (hold state) is the operational record. This is structurally identical to **Approach B**: a mutable operational record (the PaymentIntent / reservation) plus an immutable financial record (the Charge / wallet_transactions).

### PayPal

PayPal's balance page shows `available_balance` and `total_balance` as distinct values. Pending holds (e.g. seller protection holds, withdrawal holds) reduce the available balance. Each hold is tracked as a separate `pending_transaction` record with its own status lifecycle. The settled ledger is separate and immutable. This is **Approach B** with a denormalized `available_balance`.

### Adyen

Adyen's financial processing uses a **balance account** model. Pre-authorisations (holds) are tracked in a separate `Transfer` object with a `reservedFunds` status. Settlement creates an immutable ledger entry in the Balance Account's `TransactionList`. Direct mapping to **Approach B**.

### Traditional Banking (ISO 20022 / Core Banking Systems)

Banks maintain two balance figures per account: **actual balance** (sum of posted transactions) and **available balance** (actual balance minus authorised/pending holds). Authorisations are tracked in a separate `authorisations` or `holds` table with a mutable status. The posted transaction ledger is immutable. Core banking vendors (Temenos, Finastra, Mambu) all implement this as **Approach B + denormalized available balance**, with optional append-only audit trails for compliance (which approaches **Approach C** for the audit log, but Approach B for the operational state).

### Wise (formerly TransferWise)

Wise shows pending and completed transfers separately. Pending transfers reduce the "available balance" displayed to the user. Internally, pending transfers are tracked in a separate state machine; the settled ledger is immutable. **Approach B**.

### Summary

The industry consensus is: **mutable operational reservation records (Approach B) + immutable settled ledger (existing `wallet_transactions`) + denormalized available balance**. No major payment system uses a two-phase ledger (Approach D) or a pure column-based hold (Approach A) at scale.

---

## 4. Scoring Matrix

| Criterion | Approach A (column) | Approach B (reservations table) | Approach C (reservation ledger) | Approach D (two-phase ledger) |
|---|:---:|:---:|:---:|:---:|
| Preserves immutable ledger | ✅ | ✅ | ✅ | ❌ |
| Auditability (per-hold trail) | ❌ | ✅ | ✅✅ | — |
| Scalability (O(1) available balance) | ✅ | ✅ (with `reserved_balance`) | ✅ (with `reserved_balance`) | — |
| Multiple concurrent hold types | ❌ | ✅ | ✅ | — |
| Future tournament reservations | ❌ | ✅ | ✅ | — |
| Future bonus reservations | ❌ | ✅ | ✅ | — |
| Future admin holds | ❌ | ✅ | ✅ | — |
| Future fraud investigation holds | ❌ | ✅ | ✅ | — |
| Admin panel: see active holds | ❌ | ✅ | ✅ | — |
| Reconcilability | ❌ | ✅ | ✅ | — |
| Implementation simplicity | ✅✅ | ✅ | ❌ | — |
| Consistent with existing architecture | ✅ | ✅ | Partial | ❌ |
| Industry precedent at scale | ❌ | ✅ | Partial | ❌ |

---

## 5. Recommended Architecture — Approach B with Denormalized `reserved_balance`

**`wallet_reservations` table + `reserved_balance` column on `wallet_accounts`.**

### Rationale

1. **The immutable ledger is untouched.** `wallet_transactions` and `recordCompletedTransaction` behave exactly as today. The only time a ledger entry is written for a withdrawal is when the withdrawal succeeds — which is the correct, final, settled balance change.

2. **The existing `FOR UPDATE` locking pattern extends naturally.** The `wallet_accounts` row is already locked on every balance operation. Adding `reserved_balance` to that same locked row adds no new concurrency complexity.

3. **`reserved_balance` makes available balance O(1).** No JOIN needed. Every query that needs available balance computes `balance - reserved_balance` on a single row already in hand.

4. **`wallet_reservations` is reconcilable.** At any time: `SELECT SUM(amount) FROM wallet_reservations WHERE walletAccountId = ? AND status = 'active'` must equal `wallet_accounts.reserved_balance`. This query can run as a scheduled integrity check.

5. **Multiple hold types are additive.** Tournament entries, admin holds, and fraud investigations each create their own row in `wallet_reservations` with a distinct `reasonType`. They are individually releasable, queryable, and auditable without touching each other.

6. **This is what every major payment system uses.** See §3.

7. **Approach C's additional auditability is not worth its complexity here.** The operational question is "is this reservation still active?" — a single status column answers that. The forensic question "what were all the state transitions of reservation X?" is answered by the `withdrawals` table (which has its own status + timestamps) and by application logs. A full append-only reservation ledger answers a question nobody asked.

---

## 6. Integration with the Existing Wallet Design

### 6.1 New Column on `wallet_accounts`

```
wallet_accounts (modified)
  reserved_balance  bigint  NOT NULL, DEFAULT 0

  CHECK (reserved_balance >= 0)
  CHECK (balance >= reserved_balance)
```

- `balance` continues to mean exactly what it means today: the total of all settled ledger entries.
- `reserved_balance` is the denormalized sum of all active reservations.
- `available_balance` = `balance - reserved_balance` — computed at the application layer; never stored.
- The `CHECK (balance >= reserved_balance)` constraint at the DB level makes it impossible to reserve more than the settled balance, providing a hard backstop equivalent to the existing `CHECK (balance >= 0)`.

### 6.2 New `wallet_reservations` Table

```
wallet_reservations
  id               uuid          PK, default random
  walletAccountId  uuid          NOT NULL, FK → wallet_accounts.id ON DELETE RESTRICT
  amount           bigint        NOT NULL, CHECK (amount > 0)
  status           enum          NOT NULL, DEFAULT 'active'
                                 ('active' | 'confirmed' | 'released')
  reasonType       text          NOT NULL
                                 Application-defined strings, same convention as
                                 wallet_transactions.referenceType:
                                 'withdrawal' | 'tournament_entry' | 'admin_hold' | 'fraud_hold'
  reasonId         uuid          NOT NULL
                                 FK (logical) to the owning entity —
                                 withdrawals.id, tournament_entries.id, etc.
  idempotencyKey   text          NOT NULL, UNIQUE
                                 Prevents double-reservation on retry.
  confirmedAt      timestamptz   nullable — set when status → 'confirmed'
  releasedAt       timestamptz   nullable — set when status → 'released'
  createdAt        timestamptz   NOT NULL, default now()
  updatedAt        timestamptz   NOT NULL, default now()

  CHECK (status IN ('active', 'confirmed', 'released'))

  INDEXES
    (walletAccountId, status)     — sum active reservations; list holds per wallet
    (reasonType, reasonId)        — "find the reservation for withdrawal X"
    (idempotencyKey)              — covered by UNIQUE constraint
```

### 6.3 Permitted Status Transitions

```
active ──► confirmed   (withdrawal succeeded; ledger debit written atomically)
active ──► released    (withdrawal failed or cancelled; balance restored)
```

`confirmed` and `released` are terminal states. No transition out of them is legal.

### 6.4 Operation: Create Reservation (withdrawal requested)

Inside one DB transaction:
1. `SELECT … FOR UPDATE` on `wallet_accounts` (the winning_coins account).
2. Check idempotency: if a `wallet_reservations` row with this `idempotencyKey` already exists, return it — no writes.
3. Verify `balance - reserved_balance >= amount`. If not, throw `InsufficientAvailableBalanceError`.
4. `INSERT INTO wallet_reservations (status = 'active', …)`.
5. `UPDATE wallet_accounts SET reserved_balance = reserved_balance + amount`.
6. `INSERT INTO withdrawals (status = 'requested', reservationId = <new reservation id>, …)`.
7. COMMIT.

No wallet ledger entry is written. `balance` is unchanged.

### 6.5 Operation: Confirm Reservation (withdrawal succeeded)

Inside one DB transaction:
1. `SELECT … FOR UPDATE` on `wallet_accounts`.
2. `SELECT … FOR UPDATE` on `wallet_reservations` (verify `status = 'active'`, verify `amount` matches).
3. Call `recordCompletedTransaction` — writes the debit ledger entry (`-amount`) and decrements `balance`. This is the only moment a `wallet_transactions` row is written for a withdrawal.
4. `UPDATE wallet_reservations SET status = 'confirmed', confirmedAt = now()`.
5. `UPDATE wallet_accounts SET reserved_balance = reserved_balance - amount`.
   (`balance` was already decremented inside `recordCompletedTransaction` in step 3.)
6. `UPDATE withdrawals SET status = 'success', …`.
7. COMMIT.

At the moment of COMMIT: `balance` is decremented, `reserved_balance` is decremented, the ledger row exists, the reservation is `confirmed`, the withdrawal is `success`. All five are atomic.

### 6.6 Operation: Release Reservation (withdrawal failed or cancelled)

Inside one DB transaction:
1. `SELECT … FOR UPDATE` on `wallet_accounts`.
2. `SELECT … FOR UPDATE` on `wallet_reservations` (verify `status = 'active'`).
3. `UPDATE wallet_reservations SET status = 'released', releasedAt = now()`.
4. `UPDATE wallet_accounts SET reserved_balance = reserved_balance - amount`.
5. `UPDATE withdrawals SET status = 'failed' | 'cancelled', …`.
6. COMMIT.

No wallet ledger entry is written. `balance` is unchanged — the coins were never debited. The user's available balance is immediately restored.

### 6.7 Impact on `recordCompletedTransaction`

**None.** The function signature, behaviour, and call contract are unchanged. It continues to be called only for final, settled changes. A withdrawal calls it exactly once (at confirmation), passing `referenceType: 'withdrawal'` and `referenceId: withdrawal.id` — the same pattern as `'payu_deposit'` used today.

### 6.8 Available Balance Display

The user-facing balance query changes from:

```sql
-- Today
SELECT balance FROM wallet_accounts WHERE userId = ? AND walletType = 'winning_coins'
```

to:

```sql
-- With reservations
SELECT
  balance,
  reserved_balance,
  (balance - reserved_balance) AS available_balance
FROM wallet_accounts
WHERE userId = ? AND walletType = 'winning_coins'
```

No JOIN required. The presentation layer decides how to display these — e.g. show `available_balance` to the user and surface `reserved_balance` as "pending withdrawals."

### 6.9 Preventing Double-Spend

Every operation that uses Winning Coins (conversion to Play Coins, withdrawal) must check `balance - reserved_balance >= amount` rather than `balance >= amount`. The `CHECK (balance >= reserved_balance)` constraint at the DB level is the backstop. The `InsufficientAvailableBalanceError` (a new error type, analogous to the existing `InsufficientBalanceError`) is thrown when the available balance is insufficient.

The existing `convertWinningToPlay` function in `lib/wallet.ts` must be updated to check `balance - reserved_balance >= amount` — this is the **one change** required to an existing function.

---

## 7. Schema Changes Required

| Change | Reason | Impact on existing code |
|---|---|---|
| Add `reserved_balance bigint NOT NULL DEFAULT 0` to `wallet_accounts` | Core of the reservation system | Additive; existing queries still work |
| Add `CHECK (reserved_balance >= 0)` to `wallet_accounts` | DB-level backstop | None |
| Add `CHECK (balance >= reserved_balance)` to `wallet_accounts` | Prevent over-reservation | None |
| New `wallet_reservations` table | Per-hold audit trail and lifecycle | None — new table |
| Update `convertWinningToPlay` to check available balance | Prevent double-spend | One function, one additional condition |

**No existing table columns are removed or renamed. No existing constraints are dropped. No existing query is broken.** The changes are purely additive, except for the single function update.

---

## 8. Comparison: Phase 1 Design vs. Reservation Architecture

| Dimension | Phase 1 (immediate debit) | Recommended (reservation) |
|---|---|---|
| When does the ledger entry appear? | At withdrawal request | At withdrawal confirmation |
| What does the ledger row mean? | "Coins moved, possibly refunded" | "Coins moved, permanently" |
| What does the user see during pending? | Balance already debited | Balance unchanged; reserved shown separately |
| Failure handling | Reversal credit written (noise in ledger) | Reservation released; no ledger entry |
| Ledger cleanliness | Contains debit+reversal pairs | Contains only final movements |
| Audit trail of pending holds | None (withdrawal table only) | `wallet_reservations` table |
| Multiple concurrent hold types | Not supported | Supported natively |
| Schema changes from today's design | None to wallet | `reserved_balance` column + new table |

---

*End of reservation architecture evaluation. Awaiting product decision before Phase 2 design is revised.*
