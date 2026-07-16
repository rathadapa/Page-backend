// Set PayU env vars before any module that reads process.env is imported.
process.env["PAYU_KEY"] = "pmnt-test-key";
process.env["PAYU_SALT"] = "pmnt-test-salt";
process.env["PAYU_ENV"] = "test";
process.env["PAYU_SURL"] = "https://example.com/success";
process.env["PAYU_FURL"] = "https://example.com/failure";

/**
 * Mock callPayUVerify so tests never make real HTTP calls.
 * importActual preserves PayUVerifyAPIError as the real class so instanceof
 * checks and thrown errors work correctly.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("./payu-verify", async (importActual) => {
  const actual = await importActual<typeof import("./payu-verify")>();
  return { ...actual, callPayUVerify: vi.fn() };
});

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  depositsTable,
  walletAccountsTable,
  walletTransactionsTable,
  type Deposit,
} from "@workspace/db";
import { hashPassword, PASSWORD_ALGO } from "./password";
import { initiateDeposit } from "./deposit";
import { createWalletAccountsForUser } from "./wallet";
import { reconcileDeposit } from "./reconciliation";
import { callPayUVerify, PayUVerifyAPIError } from "./payu-verify";

// ── Mocked function handle ────────────────────────────────────────────────────

const mockVerify = vi.mocked(callPayUVerify);

// ── Shared state ──────────────────────────────────────────────────────────────

const prefix = `trecon${Date.now()}`;

let fullUserId = "";
let noWalletUserId = "";
let fullWalletAccountIds: string[] = [];
let playAccountId = "";

// One deposit per distinct test scenario.
let successDeposit: Deposit;
let failureDeposit: Deposit;
let alreadyDoneDeposit: Deposit; // will be manually set to "success" before tests run
let rollbackDeposit: Deposit;    // noWalletUser — no wallet accounts
let stillPendingDeposit: Deposit;
let amountMismatchDeposit: Deposit;

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const pwHash = await hashPassword("TestPass123!");

  // 1. Full user — has wallet accounts.
  const [fullUser] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-full`,
      name: "Reconcile Tester",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}full@test.example`,
      mobileNumber: `+91901${prefix.slice(-7)}`,
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  fullUserId = fullUser!.id;

  const accounts = await createWalletAccountsForUser(db, fullUserId);
  fullWalletAccountIds = accounts.map((a) => a.id);

  const [play] = accounts.filter((a) => a.walletType === "play_coins");
  playAccountId = play!.id;

  // 2. No-wallet user — intentionally has NO wallet accounts (rollback test).
  const [noWalletUser] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-nw`,
      name: "NoWallet Reconcile",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}nw@test.example`,
      mobileNumber: `+91902${prefix.slice(-7)}`,
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  noWalletUserId = noWalletUser!.id;

  // Create pending deposits for each scenario.
  const mkDeposit = async (userId: string, name: string, email: string, amount: number) =>
    (await initiateDeposit({ userId, name, email, phone: null, amount })).deposit;

  successDeposit        = await mkDeposit(fullUserId, "Reconcile Tester", `${prefix}full@test.example`, 500);
  failureDeposit        = await mkDeposit(fullUserId, "Reconcile Tester", `${prefix}full@test.example`, 200);
  alreadyDoneDeposit    = await mkDeposit(fullUserId, "Reconcile Tester", `${prefix}full@test.example`, 100);
  rollbackDeposit       = await mkDeposit(noWalletUserId, "NoWallet Reconcile", `${prefix}nw@test.example`, 300);
  stillPendingDeposit   = await mkDeposit(fullUserId, "Reconcile Tester", `${prefix}full@test.example`, 150);
  amountMismatchDeposit = await mkDeposit(fullUserId, "Reconcile Tester", `${prefix}full@test.example`, 400);

  // Pre-complete alreadyDoneDeposit so the "already_processed" test has
  // realistic data without running a full success flow.
  await db
    .update(depositsTable)
    .set({ status: "success", completedAt: new Date(), mihpayId: "PRESET_MIHPAYID", payuTxnId: alreadyDoneDeposit.merchantOrderId })
    .where(eq(depositsTable.id, alreadyDoneDeposit.id));
});

afterAll(async () => {
  const allUserIds = [fullUserId, noWalletUserId].filter(Boolean);
  if (allUserIds.length === 0) return;

  // Delete in FK-safe order.
  if (fullWalletAccountIds.length > 0) {
    await db
      .delete(walletTransactionsTable)
      .where(inArray(walletTransactionsTable.walletAccountId, fullWalletAccountIds));
  }
  await db.delete(depositsTable).where(inArray(depositsTable.userId, allUserIds));
  await db.delete(walletAccountsTable).where(inArray(walletAccountsTable.userId, allUserIds));
  await db.delete(usersTable).where(inArray(usersTable.id, allUserIds));
});

beforeEach(() => {
  mockVerify.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reconcileDeposit", () => {
  // ── 1. Unknown merchantOrderId ─────────────────────────────────────────────

  it('returns "ignored" for an unknown merchantOrderId — no DB changes, Verify API never called', async () => {
    const result = await reconcileDeposit("00000000-0000-0000-0000-000000000000");

    expect(result).toBe("ignored");
    expect(mockVerify).not.toHaveBeenCalled();
  });

  // ── 2. Already processed ───────────────────────────────────────────────────

  it('returns "already_processed" when the deposit is not pending — Verify API never called', async () => {
    const result = await reconcileDeposit(alreadyDoneDeposit.merchantOrderId);

    expect(result).toBe("already_processed");
    expect(mockVerify).not.toHaveBeenCalled();

    // Sanity check — DB row unchanged.
    const [row] = await db
      .select({ status: depositsTable.status })
      .from(depositsTable)
      .where(eq(depositsTable.id, alreadyDoneDeposit.id));
    expect(row?.status).toBe("success");
  });

  // ── 3. Verify API error ────────────────────────────────────────────────────

  it("propagates PayUVerifyAPIError and leaves deposit pending", async () => {
    mockVerify.mockRejectedValueOnce(
      new PayUVerifyAPIError("PayU Verify API returned HTTP 503."),
    );

    await expect(reconcileDeposit(successDeposit.merchantOrderId)).rejects.toThrow(
      PayUVerifyAPIError,
    );

    // Deposit must still be pending — nothing was committed.
    const [row] = await db
      .select({ status: depositsTable.status })
      .from(depositsTable)
      .where(eq(depositsTable.id, successDeposit.id));
    expect(row?.status).toBe("pending");
  });

  // ── 4. Still pending ───────────────────────────────────────────────────────

  it('returns "still_pending" when PayU also reports pending — no DB changes', async () => {
    mockVerify.mockResolvedValueOnce({ outcome: "pending", amount: "150.00" });

    const result = await reconcileDeposit(stillPendingDeposit.merchantOrderId);

    expect(result).toBe("still_pending");
    expect(mockVerify).toHaveBeenCalledWith(stillPendingDeposit.merchantOrderId);

    const [row] = await db
      .select({ status: depositsTable.status, completedAt: depositsTable.completedAt })
      .from(depositsTable)
      .where(eq(depositsTable.id, stillPendingDeposit.id));
    expect(row?.status).toBe("pending");
    expect(row?.completedAt).toBeNull();
  });

  // ── 5. Success flow ────────────────────────────────────────────────────────

  it('returns "resolved_success", updates deposit, and credits Play Coins wallet', async () => {
    mockVerify.mockResolvedValueOnce({
      outcome: "success",
      mihpayid: `MIHSUC_${prefix}`,
      field9: "",
      amount: successDeposit.amount.toFixed(2),
    });

    const result = await reconcileDeposit(successDeposit.merchantOrderId);

    expect(result).toBe("resolved_success");
    expect(mockVerify).toHaveBeenCalledWith(successDeposit.merchantOrderId);

    // Deposit row.
    const [deposit] = await db
      .select()
      .from(depositsTable)
      .where(eq(depositsTable.id, successDeposit.id));
    expect(deposit?.status).toBe("success");
    expect(deposit?.mihpayId).toBe(`MIHSUC_${prefix}`);
    expect(deposit?.payuTxnId).toBe(successDeposit.merchantOrderId);
    expect(deposit?.completedAt).not.toBeNull();

    // Wallet balance — must equal coinsToCredit.
    const [account] = await db
      .select({ balance: walletAccountsTable.balance })
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, playAccountId));
    expect(account?.balance).toBe(successDeposit.coinsToCredit);

    // Ledger entry.
    const [txn] = await db
      .select()
      .from(walletTransactionsTable)
      .where(
        eq(walletTransactionsTable.idempotencyKey, `payu_deposit:${successDeposit.id}`),
      );
    expect(txn?.amount).toBe(successDeposit.coinsToCredit);
    expect(txn?.referenceType).toBe("payu_deposit");
    expect(txn?.referenceId).toBe(successDeposit.id);
  });

  // ── 6. Idempotency: duplicate reconcile call after success ────────────────

  it('returns "already_processed" on a second reconcile call after success — no double-credit', async () => {
    // successDeposit is now "success" from the previous test.
    const result = await reconcileDeposit(successDeposit.merchantOrderId);

    expect(result).toBe("already_processed");
    expect(mockVerify).not.toHaveBeenCalled(); // pre-check exits early

    // Wallet balance must be unchanged (exactly coinsToCredit, not doubled).
    const [account] = await db
      .select({ balance: walletAccountsTable.balance })
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, playAccountId));
    expect(account?.balance).toBe(successDeposit.coinsToCredit);

    // Still exactly one ledger entry.
    const txns = await db
      .select()
      .from(walletTransactionsTable)
      .where(
        eq(walletTransactionsTable.idempotencyKey, `payu_deposit:${successDeposit.id}`),
      );
    expect(txns).toHaveLength(1);
  });

  // ── 7. Failure flow ────────────────────────────────────────────────────────

  it('returns "resolved_failure", marks deposit failed, and leaves wallet untouched', async () => {
    // Record wallet balance before the call.
    const [accountBefore] = await db
      .select({ balance: walletAccountsTable.balance })
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, playAccountId));

    const failureReason = "Payment declined by issuing bank.";

    mockVerify.mockResolvedValueOnce({
      outcome: "failure",
      mihpayid: `MIHFAIL_${prefix}`,
      field9: failureReason,
      amount: failureDeposit.amount.toFixed(2),
    });

    const result = await reconcileDeposit(failureDeposit.merchantOrderId);

    expect(result).toBe("resolved_failure");

    // Deposit row.
    const [deposit] = await db
      .select()
      .from(depositsTable)
      .where(eq(depositsTable.id, failureDeposit.id));
    expect(deposit?.status).toBe("failed");
    expect(deposit?.failureReason).toBe(failureReason);
    expect(deposit?.completedAt).not.toBeNull();

    // Wallet balance must be unchanged.
    const [accountAfter] = await db
      .select({ balance: walletAccountsTable.balance })
      .from(walletAccountsTable)
      .where(eq(walletAccountsTable.id, playAccountId));
    expect(accountAfter?.balance).toBe(accountBefore?.balance);
  });

  // ── 8. Amount mismatch ────────────────────────────────────────────────────

  it("throws and rolls back when PayU Verify returns a different amount than our DB record", async () => {
    const wrongAmount = (amountMismatchDeposit.amount + 100).toFixed(2); // e.g. "500.00" instead of "400.00"

    mockVerify.mockResolvedValueOnce({
      outcome: "success",
      mihpayid: `MIHAMT_${prefix}`,
      field9: "",
      amount: wrongAmount,
    });

    await expect(reconcileDeposit(amountMismatchDeposit.merchantOrderId)).rejects.toThrow(
      /amount mismatch/i,
    );

    // Deposit must remain pending — the transaction was rolled back.
    const [row] = await db
      .select({ status: depositsTable.status, completedAt: depositsTable.completedAt })
      .from(depositsTable)
      .where(eq(depositsTable.id, amountMismatchDeposit.id));
    expect(row?.status).toBe("pending");
    expect(row?.completedAt).toBeNull();
  });

  // ── 9. Rollback — missing wallet account ─────────────────────────────────

  it("throws and rolls back when the Play Coins wallet account is missing — deposit stays pending", async () => {
    // noWalletUser has no wallet accounts; completeSuccessfulDeposit will
    // throw after updating the deposit row, triggering ROLLBACK.
    mockVerify.mockResolvedValueOnce({
      outcome: "success",
      mihpayid: `MIHRB_${prefix}`,
      field9: "",
      amount: rollbackDeposit.amount.toFixed(2),
    });

    await expect(reconcileDeposit(rollbackDeposit.merchantOrderId)).rejects.toThrow(
      /play coins wallet not found/i,
    );

    // Deposit must still be pending — the UPDATE was rolled back.
    const [row] = await db
      .select({ status: depositsTable.status, completedAt: depositsTable.completedAt })
      .from(depositsTable)
      .where(eq(depositsTable.id, rollbackDeposit.id));
    expect(row?.status).toBe("pending");
    expect(row?.completedAt).toBeNull();
  });
});
