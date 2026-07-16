import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import app from "../app";
import { db, usersTable, depositsTable } from "@workspace/db";
import { createSession, SESSION_COOKIE_NAME } from "../lib/session";
import { hashPassword, PASSWORD_ALGO } from "../lib/password";
import { computeRequestHash, firstnameFromName } from "../lib/deposit";

// ── PayU test credentials (set before any module reads process.env) ───────────

const TEST_PAYU_KEY = "test-key-deposit";
const TEST_PAYU_SALT = "test-salt-deposit";
const TEST_PAYU_SURL = "https://example.com/payment/success";
const TEST_PAYU_FURL = "https://example.com/payment/failure";

process.env["PAYU_KEY"] = TEST_PAYU_KEY;
process.env["PAYU_SALT"] = TEST_PAYU_SALT;
process.env["PAYU_ENV"] = "test";
process.env["PAYU_SURL"] = TEST_PAYU_SURL;
process.env["PAYU_FURL"] = TEST_PAYU_FURL;

// ── Test fixtures ─────────────────────────────────────────────────────────────

const prefix = `tdep${Date.now()}`;

let fullUserId = "";
let noEmailUserId = "";
let noMobileUserId = "";
let unverifiedUserId = "";

let fullCookie = "";
let noEmailCookie = "";
let noMobileCookie = "";
let unverifiedCookie = "";

const FULL_USER_NAME = "Deposit Tester";
const FULL_USER_EMAIL = `${prefix}full@test.example`;

beforeAll(async () => {
  const pwHash = await hashPassword("TestPass123!");

  // 1. Full user — email present, mobile verified → valid deposit flow
  const [fullUser] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-full`,
      name: FULL_USER_NAME,
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: FULL_USER_EMAIL,
      mobileNumber: `+9198765${prefix.slice(-5)}0`,
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  fullUserId = fullUser!.id;

  // 2. No-email user — mobile verified, email absent → EMAIL_REQUIRED
  const [noEmailUser] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-noemail`,
      name: "NoEmail User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: null,
      mobileNumber: `+9198765${prefix.slice(-5)}1`,
      mobileVerificationStatus: "verified",
    })
    .returning({ id: usersTable.id });
  noEmailUserId = noEmailUser!.id;

  // 3. No-mobile user — email present, no mobile → MOBILE_NUMBER_REQUIRED
  const [noMobileUser] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-nomobile`,
      name: "NoMobile User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}nomobile@test.example`,
      mobileNumber: null,
      mobileVerificationStatus: "not_started",
    })
    .returning({ id: usersTable.id });
  noMobileUserId = noMobileUser!.id;

  // 4. Unverified user — email present, mobile present but not verified
  //    → MOBILE_VERIFICATION_REQUIRED
  const [unverifiedUser] = await db
    .insert(usersTable)
    .values({
      username: `${prefix}-unverified`,
      name: "Unverified User",
      age: 25,
      passwordHash: pwHash,
      passwordAlgo: PASSWORD_ALGO,
      email: `${prefix}unverified@test.example`,
      mobileNumber: `+9198765${prefix.slice(-5)}2`,
      mobileVerificationStatus: "pending",
    })
    .returning({ id: usersTable.id });
  unverifiedUserId = unverifiedUser!.id;

  // Create sessions and extract cookies
  const sessionFor = async (userId: string): Promise<string> => {
    const { token, expiresAt } = await createSession(userId);
    // Build the cookie header the same way a browser would send it.
    return `${SESSION_COOKIE_NAME}=${token}; Path=/; Expires=${expiresAt.toUTCString()}; HttpOnly`;
  };

  fullCookie = await sessionFor(fullUserId);
  noEmailCookie = await sessionFor(noEmailUserId);
  noMobileCookie = await sessionFor(noMobileUserId);
  unverifiedCookie = await sessionFor(unverifiedUserId);
});

afterAll(async () => {
  const ids = [fullUserId, noEmailUserId, noMobileUserId, unverifiedUserId].filter(Boolean);
  if (ids.length > 0) {
    // Remove deposits first (FK ON DELETE RESTRICT).
    await db.delete(depositsTable).where(inArray(depositsTable.userId, ids));
    // Removing users cascades to their sessions.
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/deposits/initiate", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app)
      .post("/api/deposits/initiate")
      .send({ amount: 500 });

    expect(res.status).toBe(401);
  });

  it("returns 400 MOBILE_NUMBER_REQUIRED when the user has no mobile number", async () => {
    const res = await request(app)
      .post("/api/deposits/initiate")
      .set("Cookie", noMobileCookie)
      .send({ amount: 500 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MOBILE_NUMBER_REQUIRED");
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 MOBILE_VERIFICATION_REQUIRED when mobile is not verified", async () => {
    const res = await request(app)
      .post("/api/deposits/initiate")
      .set("Cookie", unverifiedCookie)
      .send({ amount: 500 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MOBILE_VERIFICATION_REQUIRED");
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 EMAIL_REQUIRED when the user has no email", async () => {
    const res = await request(app)
      .post("/api/deposits/initiate")
      .set("Cookie", noEmailCookie)
      .send({ amount: 500 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EMAIL_REQUIRED");
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 INVALID_DEPOSIT_AMOUNT for an amount not in the allowed packages", async () => {
    const res = await request(app)
      .post("/api/deposits/initiate")
      .set("Cookie", fullCookie)
      .send({ amount: 123 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DEPOSIT_AMOUNT");
    expect(typeof res.body.message).toBe("string");
  });

  it("returns 400 INVALID_DEPOSIT_AMOUNT for a non-numeric amount", async () => {
    const res = await request(app)
      .post("/api/deposits/initiate")
      .set("Cookie", fullCookie)
      .send({ amount: "lots" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DEPOSIT_AMOUNT");
  });

  it("returns 400 INVALID_DEPOSIT_AMOUNT when amount is missing", async () => {
    const res = await request(app)
      .post("/api/deposits/initiate")
      .set("Cookie", fullCookie)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DEPOSIT_AMOUNT");
  });

  describe("valid authenticated request", () => {
    // Shared response captured once to avoid multiple DB rows.
    let body: {
      deposit: {
        id: string;
        userId: string;
        amount: number;
        coinsToCredit: number;
        status: string;
        merchantOrderId: string;
        completedAt: string | null;
      };
      payuFormParams: {
        key: string;
        txnid: string;
        amount: string;
        productinfo: string;
        firstname: string;
        email: string;
        phone?: string;
        surl: string;
        furl: string;
        hash: string;
      };
      paymentUrl: string;
    };

    beforeAll(async () => {
      const res = await request(app)
        .post("/api/deposits/initiate")
        .set("Cookie", fullCookie)
        .send({ amount: 500 });

      expect(res.status).toBe(201);
      body = res.body as typeof body;
    });

    it("creates a pending deposit row in the database", async () => {
      const [row] = await db
        .select()
        .from(depositsTable)
        .where(eq(depositsTable.id, body.deposit.id));

      expect(row).toBeDefined();
      expect(row!.status).toBe("pending");
      expect(row!.completedAt).toBeNull();
      expect(row!.userId).toBe(fullUserId);
      expect(row!.amount).toBe(500);
      expect(row!.coinsToCredit).toBe(500);
    });

    it("returns the deposit object with correct fields", () => {
      expect(body.deposit.userId).toBe(fullUserId);
      expect(body.deposit.amount).toBe(500);
      expect(body.deposit.coinsToCredit).toBe(500);
      expect(body.deposit.status).toBe("pending");
      expect(body.deposit.completedAt).toBeNull();
      expect(typeof body.deposit.merchantOrderId).toBe("string");
      // merchantOrderId is a UUID sent to PayU as txnid
      expect(body.deposit.merchantOrderId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("generates the correct PayU request hash", () => {
      const { payuFormParams } = body;
      const expectedHash = computeRequestHash({
        key: TEST_PAYU_KEY,
        txnid: payuFormParams.txnid,
        amount: payuFormParams.amount,
        productinfo: payuFormParams.productinfo,
        firstname: payuFormParams.firstname,
        email: payuFormParams.email,
        salt: TEST_PAYU_SALT,
      });

      expect(payuFormParams.hash).toBe(expectedHash);
    });

    it("returns correct PayU form params", () => {
      const { payuFormParams } = body;

      expect(payuFormParams.key).toBe(TEST_PAYU_KEY);
      expect(payuFormParams.txnid).toBe(body.deposit.merchantOrderId);
      expect(payuFormParams.amount).toBe("500.00");
      expect(payuFormParams.productinfo).toBe("Play Coins - ₹500");
      expect(payuFormParams.firstname).toBe(firstnameFromName(FULL_USER_NAME));
      expect(payuFormParams.email).toBe(FULL_USER_EMAIL);
      expect(payuFormParams.phone).toBeDefined();
      expect(payuFormParams.surl).toBe(TEST_PAYU_SURL);
      expect(payuFormParams.furl).toBe(TEST_PAYU_FURL);
      expect(typeof payuFormParams.hash).toBe("string");
      expect(payuFormParams.hash).toHaveLength(128); // SHA-512 hex = 128 chars
    });

    it("returns the correct PayU payment URL for test environment", () => {
      expect(body.paymentUrl).toBe("https://test.payu.in/_payment");
    });
  });
});
