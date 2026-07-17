/**
 * Bank account service.
 *
 * Manages the `user_bank_accounts` table — the registry of pre-verified bank
 * accounts that users can select when initiating a withdrawal.
 *
 * ── Soft delete ───────────────────────────────────────────────────────────────
 *
 * Physical deletion of a bank account row is blocked by the DB (ON DELETE
 * RESTRICT from withdrawals.bank_account_id). Soft delete is used instead:
 * `is_deleted = true` hides the account from the user's active list while
 * keeping the FK chain intact for historical withdrawal records.
 *
 * Deleting an account that has an active withdrawal (reserved or processing)
 * is rejected with `BankAccountInUseError` — the payout job still needs the
 * details for submission and the user must wait for the withdrawal to settle.
 *
 * ── KYC readiness ─────────────────────────────────────────────────────────────
 *
 * `is_verified` and `verified_at` are stored on the schema but not enforced by
 * this module. When a KYC gate is required, add:
 *
 *   if (!account.isVerified) throw new BankAccountNotVerifiedError();
 *
 * inside `initiateWithdrawal` in withdrawal.ts. No schema migration needed.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  userBankAccountsTable,
  withdrawalsTable,
  type UserBankAccount,
} from "@workspace/db";

// ── Error types ───────────────────────────────────────────────────────────────

export class BankAccountNotFoundError extends Error {
  constructor(id: string) {
    super(`Bank account ${id} not found or does not belong to this user.`);
    this.name = "BankAccountNotFoundError";
  }
}

export class BankAccountInUseError extends Error {
  constructor(id: string) {
    super(
      `Bank account ${id} has an active withdrawal (reserved or processing). ` +
        `Wait for the withdrawal to complete or fail before removing this account.`,
    );
    this.name = "BankAccountInUseError";
  }
}

// ── Service functions ─────────────────────────────────────────────────────────

export interface AddBankAccountInput {
  userId: string;
  accountHolderName: string;
  bankAccountNumber: string;
  /** Standard Indian IFSC code: 4 uppercase letters + '0' + 6 alphanumeric. */
  bankIfscCode: string;
  /** Optional display name for the bank (e.g. "HDFC Bank"). */
  bankName?: string;
}

/**
 * Saves a new bank account for the user.
 *
 * Does NOT verify the account with the bank — that is a future KYC step.
 * The account is created with `is_verified = false`.
 *
 * IFSC format is validated at the API layer (Zod) and backed by a DB CHECK
 * constraint. Account number and holder name must be non-blank (DB CHECK).
 */
export async function addBankAccount(
  input: AddBankAccountInput,
): Promise<UserBankAccount> {
  const [account] = await db
    .insert(userBankAccountsTable)
    .values({
      userId: input.userId,
      accountHolderName: input.accountHolderName.trim(),
      bankAccountNumber: input.bankAccountNumber.trim(),
      bankIfscCode: input.bankIfscCode.trim().toUpperCase(),
      bankName: input.bankName?.trim() || null,
    })
    .returning();

  if (!account) {
    throw new Error("Failed to insert bank account after insert.");
  }

  return account;
}

/**
 * Returns all non-deleted bank accounts belonging to the user, newest first.
 */
export async function getUserBankAccounts(userId: string): Promise<UserBankAccount[]> {
  return db
    .select()
    .from(userBankAccountsTable)
    .where(
      and(
        eq(userBankAccountsTable.userId, userId),
        eq(userBankAccountsTable.isDeleted, false),
      ),
    )
    .orderBy(userBankAccountsTable.createdAt);
}

/**
 * Returns a single non-deleted bank account by ID, with ownership validation.
 * Returns `null` if the account does not exist, is soft-deleted, or belongs
 * to a different user.
 */
export async function getBankAccount(
  id: string,
  userId: string,
): Promise<UserBankAccount | null> {
  const [account] = await db
    .select()
    .from(userBankAccountsTable)
    .where(
      and(
        eq(userBankAccountsTable.id, id),
        eq(userBankAccountsTable.userId, userId),
        eq(userBankAccountsTable.isDeleted, false),
      ),
    )
    .limit(1);

  return account ?? null;
}

/**
 * Soft-deletes a bank account.
 *
 * Throws `BankAccountNotFoundError` if the account does not exist or belongs
 * to a different user.
 *
 * Throws `BankAccountInUseError` if the account is referenced by any `reserved`
 * or `processing` withdrawal. The user must wait for the withdrawal to reach a
 * terminal state before removing the account.
 */
export async function softDeleteBankAccount(
  id: string,
  userId: string,
): Promise<void> {
  // Ownership check — must be the user's own non-deleted account.
  const account = await getBankAccount(id, userId);
  if (!account) {
    throw new BankAccountNotFoundError(id);
  }

  // Verify no in-flight withdrawal references this account.
  const [activeWithdrawal] = await db
    .select({ id: withdrawalsTable.id })
    .from(withdrawalsTable)
    .where(
      and(
        eq(withdrawalsTable.bankAccountId, id),
        inArray(withdrawalsTable.status, ["reserved", "processing"]),
      ),
    )
    .limit(1);

  if (activeWithdrawal) {
    throw new BankAccountInUseError(id);
  }

  await db
    .update(userBankAccountsTable)
    .set({ isDeleted: true, deletedAt: new Date() })
    .where(eq(userBankAccountsTable.id, id));
}
