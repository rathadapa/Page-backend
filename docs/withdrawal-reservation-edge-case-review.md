# Reservation Architecture — Full Edge Case Review

> Architecture review only. Every finding is grounded in the actual codebase.
> File and line references point to current source files.

---

## Scope

Every existing flow that touches `wallet_accounts` or `wallet_transactions` is examined against the proposed `wallet_reservations + reserved_balance` architecture. The question is whether any flow — today or planned — can produce a race condition, balance inconsistency, or audit gap.

Flows examined:
1. Deposit (Play Coins credit)
2. Conversion (Winning → Play Coins)
3. Future withdrawal (Winning Coins reservation → confirm / release)
4. Future tournament reservation (Winning Coins hold → confirm / release)
5. Concurrent combinations of the above

---

## Architecture Recap (One Paragraph)

`wallet_accounts` gains a `reserved_balance` column. `available_balance = balance - reserved_balance`. A new `wallet_reservations` table tracks each hold as a mutable-status row (`active → confirmed | released`). `recordCompletedTransaction` continues to be called only for final, settled balance changes. On withdrawal request: `reserved_balance` increases, `balance` unchanged, no ledger entry. On withdrawal success: `reserved_balance` decreases atomically with a `balance` decrease and one ledger entry. On failure/cancel: `reserved_balance` decreases, `balance` unchanged, no ledger entry.

---

## Finding 1 — BLOCKING

### `recordCompletedTransaction` does not check `balanceAfter >= account.reserved_balance`

**File:** `artifacts/api-server/src/lib/wallet.ts`, lines 105–108

```typescript
const balanceAfter = account.balance + input.amount;
if (balanceAfter < 0) {
  throw new InsufficientBalanceError(account.walletType);
}
```

**The problem:**

This check only ensures the total settled balance never goes negative. It does not ensure the settled balance stays above the reserved amount.

Consider: `balance = 1000`, `reserved_balance = 700` (an active withdrawal hold of 700). A conversion of 400 Winning Coins is attempted.

- `balanceAfter = 1000 + (–400) = 600`
- Existing check: `600 >= 0` ✅ — passes. `recordCompletedTransaction` proceeds.
- After the balance UPDATE: `balance = 600`, `reserved_balance = 700`
- DB constraint `CHECK (balance >= reserved_balance)`: `600 >= 700` ❌

The transaction aborts with a raw PostgreSQL constraint-violation error (`23514`), not an `InsufficientBalanceError`. The caller (`convertWinningToPlay`) does not catch this. The route handler at `routes/wallet.ts:79` does not catch it either. The user receives an unhandled 500 instead of a clean "insufficient available balance" response.

**Affected flows:** every Winning Coins debit — conversion today, withdrawal confirmation and any future tournament debit tomorrow.

**Required fix:** Add a second check immediately after the existing one:

```
if (balanceAfter < account.reserved_balance) {
  throw new InsufficientAvailableBalanceError(account.walletType)
}
```

`InsufficientAvailableBalanceError` is a new error type (parallel to the existing `InsufficientBalanceError`). For Play Coins, `reserved_balance` is always 0, so the new check is equivalent to the existing one and adds zero overhead.

**Note:** This fix in `recordCompletedTransaction` is the single, correct enforcement point. Because every balance debit goes through this function under a `FOR UPDATE` lock, fixing it here covers all current and future callers without requiring changes to each one individually.

---

## Finding 2 — BLOCKING

### PostgreSQL CHECK constraints are statement-level; the wrong operation order causes a mid-transaction constraint violation during withdrawal confirmation

**Context:** PostgreSQL evaluates `CHECK` constraints at the end of each individual SQL statement, not at transaction commit. `DEFERRABLE` constraints are an exception, but Drizzle ORM does not support declaring them and the existing constraints are not deferrable.

**The scenario:**

User has `balance = 1000`, `reserved_balance = 800`, consisting of two active reservations: withdrawal A (₹500) and tournament B (₹300). Withdrawal A is being confirmed.

The naive confirmation sequence is:

```
Step 1 — recordCompletedTransaction(–500):
  UPDATE wallet_accounts SET balance = 500        ← balance: 1000 → 500
  At statement end: balance=500, reserved_balance=800
  CHECK (500 >= 800) ❌  CONSTRAINT VIOLATION — transaction aborts
```

The reservation for withdrawal A is still `active`. The withdrawal stays `processing`. The wallet balance is unchanged (rolled back). But the caller gets a raw DB error, not a recoverable application error.

**Required fix:** `reserved_balance` must be decremented in a separate `UPDATE` statement that executes **before** `recordCompletedTransaction` updates `balance`. Both happen inside the same `db.transaction()` callback, so they are atomic from every external perspective, but the intra-transaction order matters for statement-level constraint evaluation.

**Correct confirmation sequence:**

```
Step 1 — UPDATE wallet_accounts SET reserved_balance = reserved_balance – 500
  After statement: balance=1000, reserved_balance=300
  CHECK (1000 >= 300) ✅

Step 2 — recordCompletedTransaction(–500):
  UPDATE wallet_accounts SET balance = 500
  After statement: balance=500, reserved_balance=300
  CHECK (500 >= 300) ✅

Step 3 — UPDATE wallet_reservations SET status = 'confirmed'
Step 4 — UPDATE withdrawals SET status = 'success'
COMMIT
```

This order is safe for any number of concurrent active reservations. It must be the mandated implementation pattern, documented explicitly.

**Single-reservation case:** When only one reservation is active (`balance = 500`, `reserved_balance = 500`), decrementing `balance` first would produce `balance = 0, reserved_balance = 500`, violating `0 >= 500`. The required order applies regardless of how many other reservations exist.

---

## Finding 3 — BLOCKING

### `routes/wallet.ts` catches `InsufficientBalanceError` but not the new `InsufficientAvailableBalanceError`

**File:** `artifacts/api-server/src/routes/wallet.ts`, lines 78–84

```typescript
} catch (error) {
  if (error instanceof InsufficientBalanceError) {
    res.status(400).json({ message: error.message });
    return;
  }
  throw error;   // ← anything else becomes a 500
}
```

After Finding 1's fix, conversions that are blocked by a reservation will throw `InsufficientAvailableBalanceError`. This route does not catch it — it re-throws, producing an unhandled 500.

**Required fix:** The catch block must handle both error types:

```
InsufficientBalanceError        → 400  (balance is genuinely insufficient, no holds involved)
InsufficientAvailableBalanceError → 400  (balance is sufficient but partially reserved)
```

The response messages should be distinct so the user understands why: one means "you don't have enough Winning Coins," the other means "you have enough but some are reserved for a pending withdrawal."

---

## Finding 4 — BLOCKING

### `GET /wallet/balance` returns total `balance`, not `available_balance` — users would see a balance they cannot spend

**File:** `artifacts/api-server/src/routes/wallet.ts`, lines 20–28

```typescript
function balancesFromAccounts(accounts: { walletType: WalletType; balance: number }[]) {
  const playCoins  = accounts.find(a => a.walletType === "play_coins");
  const winningCoins = accounts.find(a => a.walletType === "winning_coins");
  return { playCoins: playCoins.balance, winningCoins: winningCoins.balance };
}
```

`winningCoins` is returned as `balance` (total settled), not `balance – reserved_balance` (available to spend). A user with 1000 Winning Coins and a pending withdrawal of 700 would see 1000 in their UI, attempt a conversion of 800, and receive an unexpected rejection.

**Cascade:** `GetWalletBalanceResponse` in `lib/api-client-react` and `lib/api-zod` is also currently typed for a single balance field per wallet. The API schema requires a revision to expose `available`, `reserved`, and optionally `total` as separate fields for the Winning Coins account.

**Required fix:** The balance response for Winning Coins must expose at minimum:
- `available` = `balance – reserved_balance` (what the user can convert or withdraw)
- `reserved` = `reserved_balance` (what is pending withdrawal/hold) — so the UI can show "₹700 pending withdrawal"

`play_coins` is unaffected: `reserved_balance` is always 0 for Play Coins, so its displayed balance remains `balance`.

---

## Finding 5 — CONFIRMED SAFE

### Concurrent withdrawal requests from the same account

**Scenario:** Two withdrawal requests for ₹500 each against `balance = 700`, `reserved_balance = 0` (available = 700). Both arrive simultaneously.

**Execution:** Both transactions begin with `SELECT … FOR UPDATE` on `wallet_accounts`. PostgreSQL serialises them: Tx A acquires the lock first.

- Tx A: `available = 700 – 0 = 700 >= 500` ✅. Sets `reserved_balance = 500`. COMMITs.
- Tx B: acquires the lock. Reads `balance = 700`, `reserved_balance = 500`. `available = 200 < 500` ❌. Throws `InsufficientAvailableBalanceError`. Rolls back cleanly.

**Result:** Exactly one reservation succeeds. No double-reserve. No race.

---

## Finding 6 — CONFIRMED SAFE

### Concurrent conversion and withdrawal reservation

**Scenario:** Conversion of 600 Winning Coins and a withdrawal reservation of 500 arrive simultaneously. `balance = 800`, `reserved_balance = 0`.

**Case A — conversion wins the lock:**
- Conversion: `recordCompletedTransaction(–600)`. `balance → 200`. `reserved_balance` stays 0.
- Reservation: acquires lock. `available = 200 – 0 = 200 < 500` ❌. Fails cleanly.

**Case B — reservation wins the lock:**
- Reservation: `reserved_balance → 500`. `balance` stays 800.
- Conversion: acquires lock. With Finding 1's fix in place: `balanceAfter = 200`. Check `200 >= 500 (reserved_balance)` ❌. Throws `InsufficientAvailableBalanceError`. Fails cleanly.

**Result:** In both orderings, one operation succeeds and the other fails with a clean error. No race, no inconsistency.

---

## Finding 7 — CONFIRMED SAFE

### Withdrawal confirmation racing with a concurrent conversion

**Scenario:** Withdrawal confirmation and a conversion are attempted simultaneously. `balance = 1000`, `reserved_balance = 500` (the withdrawal being confirmed).

**Confirmation transaction** (using the correct order from Finding 2):
1. `UPDATE reserved_balance = 0` (decrement by 500)
2. `recordCompletedTransaction(–500)` → `balance = 500`

**Conversion transaction** arrives while confirmation is in progress (holds `FOR UPDATE` on the wallet account):
- Conversion blocks on the `FOR UPDATE` lock until confirmation commits.
- After commit: `balance = 500`, `reserved_balance = 0`. Available = 500. Conversion of ≤ 500 succeeds.

**Result:** Perfect serialisation. No race.

---

## Finding 8 — CONFIRMED SAFE

### Deposit flow (Play Coins credit)

`completeSuccessfulDeposit` calls `recordCompletedTransaction` to credit `play_coins`. Play Coins never have reservations — `reserved_balance = 0` always by design (only Winning Coins can be held).

With Finding 1's fix: `balanceAfter >= account.reserved_balance` → `balanceAfter >= 0`. Equivalent to the existing check. **No change to the deposit flow whatsoever.**

`completeFailedDeposit` updates the deposit row only; it never touches the wallet. Also unaffected.

`reconcileDeposit` calls both completion functions. Also unaffected.

---

## Finding 9 — CONFIRMED SAFE

### Winning Coins credit (tournament win, future)

Tournament win calls `recordCompletedTransaction` with a positive `amount` (credit). `balanceAfter = balance + amount > balance`. Both the existing `balanceAfter >= 0` check and the new `balanceAfter >= reserved_balance` check always pass for a credit. **No issue.**

---

## Finding 10 — CONFIRMED SAFE

### Multiple concurrent hold types (withdrawal + tournament hold)

**Scenario:** User has `balance = 1000`. A withdrawal reservation of 500 and a tournament entry reservation of 300 both exist. `reserved_balance = 800`. `available = 200`.

Each reservation is an independent row in `wallet_reservations`. Releasing the tournament hold only decrements `reserved_balance` by 300 — the withdrawal reservation row is untouched.

**Confirmation of the withdrawal (500):**
- Step 1: `reserved_balance = 800 – 500 = 300` (only the tournament hold remains)
- Step 2: `recordCompletedTransaction(–500)`: `balance = 500`. Check `500 >= 300` ✅
- Tournament hold still active: `reserved_balance = 300`, `balance = 500`, available = 200.

**Result:** Two hold types coexist and are released independently without affecting each other. The architecture supports N concurrent hold types on the same wallet account.

---

## Finding 11 — CONFIRMED SAFE

### Idempotency on retry: duplicate reservation creation

**Scenario:** Server commits the withdrawal creation transaction (reservation row + `reserved_balance` incremented) but crashes before returning the HTTP response. Client retries.

The retry hits the `idempotencyKey UNIQUE` constraint on `wallet_reservations`. The application idempotency check finds the existing reservation row and returns it without inserting a new row or incrementing `reserved_balance` a second time. The withdrawal row has the same idempotency guard.

**Result:** No double-reserve. Balance unchanged from the first (committed) attempt.

---

## Finding 12 — CONFIRMED SAFE

### Idempotency on retry: duplicate confirmation (PayU webhook redelivery)

The confirmation flow checks `wallet_reservations.status = 'active'` inside the `FOR UPDATE` lock before doing any writes. A redelivered webhook finds `status = 'confirmed'` and exits early — no second balance debit, no second `reserved_balance` decrement. Additionally, `withdrawals.status = 'success'` provides a second guard at the outer layer.

**Result:** Idempotent by construction. No double-debit.

---

## Finding 13 — CONFIRMED SAFE

### Orphaned reservation: crash between reservation creation and withdrawal row creation

Both the `wallet_reservations` insert and the `withdrawals` insert happen inside the same `db.transaction()`. PostgreSQL commits or rolls back both atomically. There is no crash point between them that leaves a reservation without a withdrawal row or vice versa.

**Result:** Orphaned reservations are structurally impossible.

---

## Finding 14 — CONFIRMED SAFE

### Audit trail completeness for failed / cancelled withdrawals

**Concern:** With the reservation system, a failed withdrawal leaves no `wallet_transactions` ledger row. Is there an audit gap?

**Assessment:** No. The `wallet_transactions` ledger records only settled balance changes — this is its documented contract. A failed withdrawal never changes the user's balance, so no ledger entry is correct. The audit trail for a failed withdrawal is:

| Record | What it proves |
|---|---|
| `withdrawals` row (`status = 'failed'`) | A withdrawal was requested, processed, and failed |
| `wallet_reservations` row (`status = 'released'`) | ₹N was held and released, with timestamps |
| `withdrawals.failureReason` | Why it failed |
| `withdrawals.payuTransferId` | Which PayU payout was attempted |

This is equivalent to (and arguably cleaner than) a debit+reversal pair in the ledger. The debit+reversal approach makes the ledger harder to read — it contains "temporary" entries that net to zero and are unrelated to the user's actual balance history. The reservation approach keeps the ledger as a pure record of permanent balance changes.

**Result:** No audit gap. The audit trail is split correctly between the immutable ledger (permanent changes) and the operational reservation table (temporary holds), which is the industry-standard pattern.

---

## Finding 15 — INFORMATIONAL

### `reversalOfTransactionId` on `wallet_transactions` — not used for withdrawals

The existing `reversalOfTransactionId` field was designed to link a correcting entry back to the transaction it reverses. With the reservation system, failed withdrawals never produce a ledger entry, so this field is never set for withdrawal-related transactions.

The field remains available for other use cases — future manual corrections, accounting adjustments, or any module that does need a reversal pattern. No action required.

---

## Summary Table

| # | Finding | Severity | Affected code |
|---|---|---|---|
| 1 | `recordCompletedTransaction` missing `balanceAfter >= reserved_balance` check | **BLOCKING** | `lib/wallet.ts` |
| 2 | Confirmation operation order: `reserved_balance` must be decremented before `balance` (PostgreSQL statement-level CHECK) | **BLOCKING** | Withdrawal confirmation implementation (Phase 2) |
| 3 | `routes/wallet.ts` does not catch `InsufficientAvailableBalanceError` | **BLOCKING** | `routes/wallet.ts` |
| 4 | `GET /wallet/balance` returns total `balance` not `available_balance` | **BLOCKING** | `routes/wallet.ts`, `lib/api-zod`, `lib/api-client-react` |
| 5 | Concurrent withdrawal requests | Safe | — |
| 6 | Concurrent conversion + reservation | Safe | — |
| 7 | Withdrawal confirmation vs. concurrent conversion | Safe | — |
| 8 | Deposit flow (Play Coins credit) | Safe | — |
| 9 | Winning Coins credit (tournament win) | Safe | — |
| 10 | Multiple concurrent hold types | Safe | — |
| 11 | Duplicate reservation on retry | Safe | — |
| 12 | Duplicate PayU webhook (confirmation retry) | Safe | — |
| 13 | Orphaned reservation on crash | Safe | — |
| 14 | Audit trail for failed withdrawals | Safe | — |
| 15 | `reversalOfTransactionId` unused for withdrawals | Informational | — |

---

## Required Changes Before Implementation

### 1. `lib/wallet.ts` — `recordCompletedTransaction`

Add immediately after the existing insufficient-balance check:

```
new InsufficientAvailableBalanceError class (parallel to InsufficientBalanceError)

Inside recordCompletedTransaction, after "const balanceAfter = account.balance + input.amount":
  if (balanceAfter < 0) → throw InsufficientBalanceError          (existing)
  if (balanceAfter < account.reserved_balance) → throw InsufficientAvailableBalanceError  (NEW)
```

This is the single enforcement point. All callers — conversion, withdrawal confirmation, and every future Winning Coins debit — are automatically covered.

### 2. `routes/wallet.ts` — conversion error handler

Catch `InsufficientAvailableBalanceError` alongside `InsufficientBalanceError`, with a distinct 400 response message explaining the reservation.

### 3. `routes/wallet.ts` — balance endpoint

Return `available` (`balance – reserved_balance`) and `reserved` (`reserved_balance`) as separate fields for Winning Coins. Update `lib/api-zod` (`GetWalletBalanceResponse`) and `lib/api-client-react` accordingly.

### 4. Withdrawal confirmation implementation (Phase 2)

Mandate the operation order documented in Finding 2:
1. `UPDATE wallet_accounts SET reserved_balance = reserved_balance – amount` (FIRST)
2. `recordCompletedTransaction(tx, { amount: –amount, … })` (SECOND)
3. `UPDATE wallet_reservations SET status = 'confirmed'`
4. `UPDATE withdrawals SET status = 'success'`

Deviation from this order will produce a constraint violation when multiple reservations are active.

---

## Verdict

**The `wallet_reservations + reserved_balance` architecture is sound. It is not yet production-ready.**

The four blocking findings are all implementation issues, not architectural flaws. The reservation model itself is correct: it is race-free under `FOR UPDATE` serialisation, idempotent at every retry boundary, audit-complete, and extensible to N concurrent hold types. Findings 5–15 confirm that every existing flow and all planned future flows integrate cleanly.

The four blockers are targeted, fully defined, and fixable without touching the existing immutable ledger, the deposit module, the PayU callback handlers, or the reconciliation service. Once addressed, the architecture is production-ready.
