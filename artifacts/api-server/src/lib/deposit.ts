import { createHash, randomUUID } from "node:crypto";
import { db, depositsTable, type Deposit } from "@workspace/db";

// ── PayU configuration ────────────────────────────────────────────────────────

const PAYU_PAYMENT_URLS = {
  test: "https://test.payu.in/_payment",
  production: "https://secure.payu.in/_payment",
} as const;

type PayUEnv = keyof typeof PAYU_PAYMENT_URLS;

export function getPayUConfig(): {
  key: string;
  salt: string;
  paymentUrl: string;
  surl: string;
  furl: string;
} {
  const key = process.env["PAYU_KEY"];
  const salt = process.env["PAYU_SALT"];
  const env = (process.env["PAYU_ENV"] ?? "test") as PayUEnv;
  const surl = process.env["PAYU_SURL"];
  const furl = process.env["PAYU_FURL"];

  if (!key) throw new Error("PAYU_KEY environment variable is required.");
  if (!salt) throw new Error("PAYU_SALT environment variable is required.");
  if (!(env in PAYU_PAYMENT_URLS)) {
    throw new Error(`PAYU_ENV must be "test" or "production", got "${env}".`);
  }
  if (!surl) throw new Error("PAYU_SURL environment variable is required.");
  if (!furl) throw new Error("PAYU_FURL environment variable is required.");

  return { key, salt, paymentUrl: PAYU_PAYMENT_URLS[env], surl, furl };
}

// ── Hash ──────────────────────────────────────────────────────────────────────

/**
 * Computes the PayU SHA-512 payment request hash.
 *
 * Formula (official PayU documentation):
 *   sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
 *
 * udf1–udf5 and the 5 trailing positions are all empty strings, giving
 * 10 empty fields between email and SALT (11 pipe separators total).
 *
 * @see https://docs.payu.in/docs/hashing-request-and-response
 */
export function computeRequestHash(params: {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  salt: string;
}): string {
  const parts = [
    params.key,
    params.txnid,
    params.amount,
    params.productinfo,
    params.firstname,
    params.email,
    "", // udf1
    "", // udf2
    "", // udf3
    "", // udf4
    "", // udf5
    "", // trailing position 1
    "", // trailing position 2
    "", // trailing position 3
    "", // trailing position 4
    "", // trailing position 5
    params.salt,
  ];

  return createHash("sha512").update(parts.join("|")).digest("hex");
}

// ── Firstname derivation ──────────────────────────────────────────────────────

/**
 * Derives the PayU `firstname` from the user's stored full name:
 * the first word before the first space, or the full name if no space exists.
 */
export function firstnameFromName(name: string): string {
  const spaceIndex = name.indexOf(" ");
  return spaceIndex === -1 ? name : name.slice(0, spaceIndex);
}

// ── Service ───────────────────────────────────────────────────────────────────

export interface DepositInitiateInput {
  userId: string;
  /** Full name from users.name — used to derive firstname for PayU. */
  name: string;
  email: string;
  /** Passed to PayU as `phone` when present (verified mobile number). */
  phone?: string | null;
  amount: number;
}

export interface DepositInitiateResult {
  deposit: Deposit;
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
}

/**
 * Creates a pending deposit row and builds the PayU form parameters the
 * frontend will POST directly to PayU's payment page.
 *
 * Wallet balances and coin credits are intentionally not touched here.
 * Coins are credited only after PayU confirms a successful payment via webhook.
 */
export async function initiateDeposit(
  input: DepositInitiateInput,
): Promise<DepositInitiateResult> {
  const { key, salt, paymentUrl, surl, furl } = getPayUConfig();

  // One UUID per deposit attempt — sent to PayU as `txnid` and persisted as
  // `merchant_order_id`. Used as the join key for incoming webhooks.
  const merchantOrderId = randomUUID();

  // PayU requires amount as a decimal string (e.g. "500.00").
  const amountStr = input.amount.toFixed(2);
  const productinfo = `Play Coins - ₹${input.amount}`;
  const firstname = firstnameFromName(input.name);

  const hash = computeRequestHash({
    key,
    txnid: merchantOrderId,
    amount: amountStr,
    productinfo,
    firstname,
    email: input.email,
    salt,
  });

  const [deposit] = await db
    .insert(depositsTable)
    .values({
      userId: input.userId,
      amount: input.amount,
      coinsToCredit: input.amount, // 1 coin = ₹1 under current rate
      status: "pending",
      merchantOrderId,
      completedAt: null,
    })
    .returning();

  if (!deposit) {
    throw new Error("Failed to create deposit record after insert.");
  }

  const payuFormParams: DepositInitiateResult["payuFormParams"] = {
    key,
    txnid: merchantOrderId,
    amount: amountStr,
    productinfo,
    firstname,
    email: input.email,
    surl,
    furl,
    hash,
  };

  if (input.phone) {
    payuFormParams.phone = input.phone;
  }

  return { deposit, payuFormParams, paymentUrl };
}
