// Set PayU env vars before any module that reads process.env is imported.
process.env["PAYU_KEY"] = "pmnt-test-key";
process.env["PAYU_SALT"] = "pmnt-test-salt";
process.env["PAYU_ENV"] = "test";
process.env["PAYU_SURL"] = "https://example.com/success";
process.env["PAYU_FURL"] = "https://example.com/failure";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import app from "../app";
import {
  db,
  usersTable,
  depositsTable,
  walletAccountsTable,
  walletTransactionsTable,
  type Deposit,
} from "@workspace/db";
import { hashPassword, PASSWORD_ALGO } from "../lib/password";
import { initiateDeposit, firstnameFromName } from "../lib/deposit";
import { computeReverseHash } from "../lib/payu";
import { createWalletAccountsForUser } from "../lib/wallet";

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_KEY = "pmnt-test-key";
const TEST_SALT = "pmnt-test-salt";

// ── Shared state (populated in beforeAll) ─────────────────────────────────────

const prefix = `tpay${Date.now()}`;

let fullUserId = "";
let noWalletUserId = "";
let fullUserEmail = "";
let fullUserName = "";

let fullWalletAccountIds: string[] = [];

// One deposit per test scenario to avoid state contamination between tests.
let successDeposit: Deposit;   // success flow + duplicate idempotency
let failureDeposit: Deposit;   // failure flow
let rollbackDeposit: Deposit;  // rollback when wallet is missing

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a valid PayU callback body with the correct reverse hash,
 * using the same field values that were sent to PayU during initiation.
 */
function buildCallbackBody(params: {
  deposit: Deposit;
  userEmail: string;
  userName: string;
  status: "success" | "failure";
  mihpayid?: string;
  field9?: string;
}) {
  const amountStr = params.deposit.amount.toFixed(2);
  const productinfo = `Play Coins - ₹${params.deposit.amount}`;
  const firstname = firstnameFromName(params.userName);
  const txnid = params.deposit.merchantOrderId;

  const hash = computeReverseHash({
    salt: TEST_SALT,
    status: params.status,
    udf5: "",
    udf4: "",
    udf3: "",
    udf2: "",
    udf1: "",
    email: params.userEmail,
    firstname,
    productinfo,
    amount: amountStr,
    txnid,
    key: TEST_KEY,
  });

  return {
    txnid,
    amount: amountStr,
    productinfo,
    firstname,
    email: params.userEmail,
    status: params.status,
    hash,
    mihpayid: params.mihpayid ?? randomUUID(),
    key: TEST_KEY,
    udf1: "",
    udf2: "",
    udf3: "",
    udf4: "",
    udf5: "",
    field9: params.field9 ?? "",
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const pwHash = await hashPassword("TestPass123!");
  fullUserEmail = `${prefix}full@test.example`;
  fullUserName = "Payment Tester";

  // 1. Full user — has wallet accounts; used for success/failure/duplicate tests.
  const [fullUser] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-full`,
      name: fullUserName,
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: fullUserEmail,
      mobileNumber: `+91987${prefix.slice(-7)}`,
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  fullUserId = fullUser!.id;

  // Create both wallet accounts for the full user.
  const accounts = await createWalletAccountsForUser(db, fullUserId);
  fullWalletAccountIds = accounts.map((a) => a.id);

  // 2. No-wallet user — intentionally has NO wallet accounts; used for the
  //    rollback test to verify that a failed wallet credit leaves the deposit
  //    status unchanged (still "pending").
  const [noWalletUser] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-nowallet`,
      name: "NoWallet User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}nowallet@test.example`,
      mobileNumber: `+91988${prefix.slice(-7)}`,
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  noWalletUserId = noWalletUser!.id;

  // Create one pending deposit per scenario via the real initiateDeposit
  // service so merchantOrderId, productinfo, etc. are consistent with what
  // would be sent to PayU during a real initiation.

  const makeDeposit = async (userId: string, name: string, email: string, amount: number) => {
    const result = await initiateDeposit({ userId, name, email, phone: null, amount });
    return result.deposit;
  };

  successDeposit = await makeDeposit(fullUserId, fullUserName, fullUserEmail, 500);
  failureDeposit = await makeDeposit(fullUserId, fullUserName, fullUserEmail, 100);
  rollbackDeposit = await makeDeposit(noWalletUserId, "NoWallet User", `${prefix}nowallet@test.example`, 200);
});

afterAll(async () => {
  const allUserIds = [fullUserId, noWalletUserId].filter(Boolean);
  if (allUserIds.length === 0) return;

  // Delete in FK-safe order:
  // 1. wallet_transactions → wallet_accounts (RESTRICT)
  if (fullWalletAccountIds.length > 0) {
    await db
      .delete(walletTransactionsTable)
      .where(inArray(walletTransactionsTable.walletAccountId, fullWalletAccountIds));
  }
  // 2. deposits → users (RESTRICT)
  await db.delete(depositsTable).where(inArray(depositsTable.userId, allUserIds));
  // 3. wallet_accounts → users (RESTRICT)
  await db.delete(walletAccountsTable).where(inArray(walletAccountsTable.userId, allUserIds));
  // 4. users (cascades to user_sessions)
  await db.delete(usersTable).where(inArray(usersTable.id, allUserIds));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/payments/payu/success", () => {
  it("returns 400 when the hash is invalid", async () => {
    const body = buildCallbackBody({
      deposit: successDeposit,
      userEmail: fullUserEmail,
      userName: fullUserName,
      status: "success",
    });

    // Corrupt the hash — flip one character.
    const corruptHash = body.hash.replace(body.hash[0]!, body.hash[0] === "a" ? "b" : "a");

    const res = await request(app)
      .post("/api/payments/payu/success")
      .type("form")
      .send({ ...body, hash: corruptHash });

    expect(res.status).toBe(400);

    // Deposit must remain pending — hash failure must not touch the DB.
    const [row] = await db
      .select({ status: depositsTable.status })
      .from(depositsTable)
      .where(eq(depositsTable.id, successDeposit.id));
    expect(row?.status).toBe("pending");
  });

  it("returns 404 for an unknown txnid", async () => {
    const fakeTxnid = randomUUID();
    const fakeMihpayid = randomUUID();

    // Compute a valid hash for the fake txnid so the request passes hash
    // verification and reaches the deposit-lookup step.
    const hash = computeReverseHash({
      salt: TEST_SALT,
      status: "success",
      udf5: "",
      udf4: "",
      udf3: "",
      udf2: "",
      udf1: "",
      email: fullUserEmail,
      firstname: firstnameFromName(fullUserName),
      productinfo: "Play Coins - ₹500",
      amount: "500.00",
      txnid: fakeTxnid,
      key: TEST_KEY,
    });

    const res = await request(app)
      .post("/api/payments/payu/success")
      .type("form")
      .send({
        txnid: fakeTxnid,
        amount: "500.00",
        productinfo: "Play Coins - ₹500",
        firstname: firstnameFromName(fullUserName),
        email: fullUserEmail,
        status: "success",
        hash,
        mihpayid: fakeMihpayid,
        key: TEST_KEY,
        udf1: "",
        udf2: "",
        udf3: "",
        udf4: "",
        udf5: "",
        field9: "",
      });

    // Unknown txnid must now return 200 (not 404) so PayU stops retrying.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
  });

  describe("valid success flow", () => {
    // Shared body — reused in duplicate test to confirm idempotency.
    let callbackBody: ReturnType<typeof buildCallbackBody>;
    let playAccountIdForCheck: string;

    beforeAll(async () => {
      callbackBody = buildCallbackBody({
        deposit: successDeposit,
        userEmail: fullUserEmail,
        userName: fullUserName,
        status: "success",
        mihpayid: `MIID_SUC_${prefix}`,
      });

      // Identify the play_coins wallet account so we can check its balance.
      const [playAccount] = await db
        .select()
        .from(walletAccountsTable)
        .where(
          and(
            eq(walletAccountsTable.userId, fullUserId),
            eq(walletAccountsTable.walletType, "play_coins"),
          ),
        );
      playAccountIdForCheck = playAccount!.id;
    });

    it("returns 200, marks deposit as success, and credits Play Coins wallet", async () => {
      const res = await request(app)
        .post("/api/payments/payu/success")
        .type("form")
        .send(callbackBody);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Deposit row must be updated correctly.
      const [deposit] = await db
        .select()
        .from(depositsTable)
        .where(eq(depositsTable.id, successDeposit.id));

      expect(deposit?.status).toBe("success");
      expect(deposit?.mihpayId).toBe(`MIID_SUC_${prefix}`);
      expect(deposit?.payuTxnId).toBe(successDeposit.merchantOrderId);
      expect(deposit?.completedAt).not.toBeNull();

      // Play Coins wallet must be credited.
      const [account] = await db
        .select()
        .from(walletAccountsTable)
        .where(eq(walletAccountsTable.id, playAccountIdForCheck));
      expect(account?.balance).toBe(successDeposit.coinsToCredit);

      // Ledger entry must exist.
      const [txn] = await db
        .select()
        .from(walletTransactionsTable)
        .where(eq(walletTransactionsTable.idempotencyKey, `payu_deposit:${successDeposit.id}`));
      expect(txn?.amount).toBe(successDeposit.coinsToCredit);
      expect(txn?.referenceType).toBe("payu_deposit");
      expect(txn?.referenceId).toBe(successDeposit.id);
      expect(txn?.description).toBe("PayU Deposit");
    });

    it("returns 200 on duplicate callback without double-crediting the wallet", async () => {
      const res = await request(app)
        .post("/api/payments/payu/success")
        .type("form")
        .send(callbackBody);

      // Must be idempotent — same 200 response.
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Wallet balance must not have changed from the first callback.
      const [account] = await db
        .select()
        .from(walletAccountsTable)
        .where(eq(walletAccountsTable.id, playAccountIdForCheck));
      expect(account?.balance).toBe(successDeposit.coinsToCredit);

      // Exactly one ledger entry must exist for this deposit.
      const txns = await db
        .select()
        .from(walletTransactionsTable)
        .where(eq(walletTransactionsTable.idempotencyKey, `payu_deposit:${successDeposit.id}`));
      expect(txns).toHaveLength(1);
    });
  });
});

describe("POST /api/payments/payu/failure", () => {
  it("returns 200, marks deposit as failed, and does not touch the wallet", async () => {
    const failureReason = "Payment declined by bank.";
    const callbackBody = buildCallbackBody({
      deposit: failureDeposit,
      userEmail: fullUserEmail,
      userName: fullUserName,
      status: "failure",
      field9: failureReason,
    });

    // Record the wallet balance before the callback.
    const [accountBefore] = await db
      .select({ balance: walletAccountsTable.balance })
      .from(walletAccountsTable)
      .where(
        and(
          eq(walletAccountsTable.userId, fullUserId),
          eq(walletAccountsTable.walletType, "play_coins"),
        ),
      );

    const res = await request(app)
      .post("/api/payments/payu/failure")
      .type("form")
      .send(callbackBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Deposit must be marked as failed with the reason.
    const [deposit] = await db
      .select()
      .from(depositsTable)
      .where(eq(depositsTable.id, failureDeposit.id));

    expect(deposit?.status).toBe("failed");
    expect(deposit?.failureReason).toBe(failureReason);
    expect(deposit?.completedAt).not.toBeNull();

    // Wallet balance must be unchanged — failure must never credit coins.
    const [accountAfter] = await db
      .select({ balance: walletAccountsTable.balance })
      .from(walletAccountsTable)
      .where(
        and(
          eq(walletAccountsTable.userId, fullUserId),
          eq(walletAccountsTable.walletType, "play_coins"),
        ),
      );
    expect(accountAfter?.balance).toBe(accountBefore?.balance);
  });

  it("returns 200 on duplicate failure callback (idempotent)", async () => {
    // failureDeposit is now in "failed" state after the previous test.
    const callbackBody = buildCallbackBody({
      deposit: failureDeposit,
      userEmail: fullUserEmail,
      userName: fullUserName,
      status: "failure",
    });

    const res = await request(app)
      .post("/api/payments/payu/failure")
      .type("form")
      .send(callbackBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("Rollback behaviour", () => {
  it("leaves deposit pending when the Play Coins wallet account is missing", async () => {
    // noWalletUser has no wallet accounts.  processPayUSuccess will fail when
    // it cannot find the play_coins account, triggering a DB ROLLBACK that
    // undoes the deposit UPDATE.

    const callbackBody = buildCallbackBody({
      deposit: rollbackDeposit,
      userEmail: `${prefix}nowallet@test.example`,
      userName: "NoWallet User",
      status: "success",
      mihpayid: `MIID_RB_${prefix}`,
    });

    const res = await request(app)
      .post("/api/payments/payu/success")
      .type("form")
      .send(callbackBody);

    // The server correctly returns 500 because an unexpected internal error
    // occurred (no wallet account found) after hash verification succeeded.
    expect(res.status).toBe(500);

    // The critical assertion: the deposit must still be pending after the
    // failed/rolled-back attempt.
    const [deposit] = await db
      .select({ status: depositsTable.status, completedAt: depositsTable.completedAt })
      .from(depositsTable)
      .where(eq(depositsTable.id, rollbackDeposit.id));

    expect(deposit?.status).toBe("pending");
    expect(deposit?.completedAt).toBeNull();
  });
});
