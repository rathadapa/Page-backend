import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import {
  db,
  walletAccountsTable,
  walletTransactionsTable,
  type WalletAccount,
  type WalletTransaction,
} from "@workspace/db";

// A database client that can either be the top-level `db` or a transaction
// handle (`tx`) passed down from `db.transaction(...)`. Every function here
// accepts one of these so callers can compose multiple wallet operations
// into a single atomic transaction (e.g. signup, conversion).
type DbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

export const WALLET_TYPES = ["play_coins", "winning_coins"] as const;
export type WalletType = (typeof WALLET_TYPES)[number];

export class InsufficientBalanceError extends Error {
  constructor(walletType: WalletType) {
    super(`Insufficient ${walletType} balance for this operation.`);
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Creates both wallet accounts (Play Coins, Winning Coins) for a new user,
 * both starting at a balance of 0. Intended to run inside the same
 * transaction as user creation, so a user can never exist without wallets.
 */
export async function createWalletAccountsForUser(
  executor: DbExecutor,
  userId: string,
): Promise<WalletAccount[]> {
  return executor
    .insert(walletAccountsTable)
    .values(WALLET_TYPES.map((walletType) => ({ userId, walletType })))
    .returning();
}

/** Returns both wallet accounts (Play Coins, Winning Coins) for a user. */
export async function getWalletAccountsForUser(userId: string): Promise<WalletAccount[]> {
  return db.select().from(walletAccountsTable).where(eq(walletAccountsTable.userId, userId));
}

export interface RecordTransactionInput {
  walletAccountId: string;
  /** Signed whole-coin amount: positive = credit, negative = debit. */
  amount: number;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey: string;
  reversalOfTransactionId?: string;
  description?: string;
}

/**
 * Records one completed, immutable ledger entry and updates the owning
 * wallet account's cached balance, atomically. Must be called with a `tx`
 * from `db.transaction(...)` by the caller so the ledger insert and the
 * balance update either both succeed or both fail together.
 *
 * Idempotent: if a transaction with the same `idempotencyKey` already
 * exists, it is returned as-is instead of being applied again — this is
 * what lets a caller safely retry "record this completed change" without
 * double-crediting/debiting.
 *
 * Throws `InsufficientBalanceError` if applying `amount` would take the
 * wallet negative (checked here for a clean, catchable error; the
 * `wallet_accounts_balance_non_negative` DB constraint is the backstop of
 * last resort in case this check is ever bypassed).
 */
export async function recordCompletedTransaction(
  tx: DbExecutor,
  input: RecordTransactionInput,
): Promise<WalletTransaction> {
  // Acquire the row lock BEFORE checking the idempotency key. This
  // serializes all concurrent callers targeting the same wallet account:
  // by the time a second request acquires the lock, the first has already
  // committed its ledger row, so the idempotency check below will find it
  // and return early — eliminating the TOCTOU window between "check key"
  // and "insert row" that would otherwise cause a unique-constraint error.
  const [account] = await tx
    .select()
    .from(walletAccountsTable)
    .where(eq(walletAccountsTable.id, input.walletAccountId))
    .for("update");

  if (!account) {
    throw new Error(`Wallet account ${input.walletAccountId} does not exist.`);
  }

  // Idempotency check runs after the lock so it always reads committed state.
  const [existing] = await tx
    .select()
    .from(walletTransactionsTable)
    .where(eq(walletTransactionsTable.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (existing) {
    return existing;
  }

  const balanceAfter = account.balance + input.amount;
  if (balanceAfter < 0) {
    throw new InsufficientBalanceError(account.walletType);
  }

  const [transaction] = await tx
    .insert(walletTransactionsTable)
    .values({
      walletAccountId: input.walletAccountId,
      amount: input.amount,
      balanceAfter,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyKey: input.idempotencyKey,
      reversalOfTransactionId: input.reversalOfTransactionId,
      description: input.description,
    })
    .returning();

  if (!transaction) {
    throw new Error("Failed to record wallet transaction after insert.");
  }

  await tx
    .update(walletAccountsTable)
    .set({ balance: balanceAfter })
    .where(eq(walletAccountsTable.id, input.walletAccountId));

  return transaction;
}

export interface ConversionResult {
  debitTransaction: WalletTransaction;
  creditTransaction: WalletTransaction;
  playCoinsBalance: number;
  winningCoinsBalance: number;
}

/**
 * Converts `amount` Winning Coins into Play Coins for a user, atomically:
 * one debit against Winning Coins and one credit against Play Coins are
 * written (plus both balance updates) inside a single DB transaction, so
 * they either both succeed or both fail together. The two ledger rows are
 * linked via a shared `reference_id` (`referenceType: "conversion"`) so
 * they can be queried as a pair.
 *
 * `idempotencyKey` is supplied by the caller (see routes/wallet.ts) and
 * suffixed per leg (`:debit` / `:credit`) so a retried request with the
 * same key cannot double-apply the conversion.
 */
export async function convertWinningToPlay(
  userId: string,
  amount: number,
  idempotencyKey: string,
): Promise<ConversionResult> {
  return db.transaction(async (tx) => {
    // Fetch in a fixed order (winning, then play) on every call so
    // concurrent conversions for the same user always acquire row locks in
    // the same order, avoiding deadlocks.
    const [winningAccount] = await tx
      .select()
      .from(walletAccountsTable)
      .where(
        and(
          eq(walletAccountsTable.userId, userId),
          eq(walletAccountsTable.walletType, "winning_coins"),
        ) as SQL,
      )
      .for("update");

    const [playAccount] = await tx
      .select()
      .from(walletAccountsTable)
      .where(
        and(
          eq(walletAccountsTable.userId, userId),
          eq(walletAccountsTable.walletType, "play_coins"),
        ) as SQL,
      )
      .for("update");

    if (!winningAccount || !playAccount) {
      throw new Error(`User ${userId} is missing one or both wallet accounts.`);
    }

    const conversionReferenceId = randomUUID();

    const debitTransaction = await recordCompletedTransaction(tx, {
      walletAccountId: winningAccount.id,
      amount: -amount,
      referenceType: "conversion",
      referenceId: conversionReferenceId,
      idempotencyKey: `${idempotencyKey}:debit`,
      description: "Converted to Play Coins",
    });

    const creditTransaction = await recordCompletedTransaction(tx, {
      walletAccountId: playAccount.id,
      amount,
      referenceType: "conversion",
      referenceId: conversionReferenceId,
      idempotencyKey: `${idempotencyKey}:credit`,
      description: "Converted from Winning Coins",
    });

    return {
      debitTransaction,
      creditTransaction,
      playCoinsBalance: creditTransaction.balanceAfter,
      winningCoinsBalance: debitTransaction.balanceAfter,
    };
  });
}

export interface TransactionHistoryQuery {
  walletAccountId: string;
  limit: number;
  before?: Date;
}

/** Returns a page of a wallet account's ledger, newest first. */
export async function getWalletTransactions(
  query: TransactionHistoryQuery,
): Promise<WalletTransaction[]> {
  const conditions = [eq(walletTransactionsTable.walletAccountId, query.walletAccountId)];
  if (query.before) {
    conditions.push(lt(walletTransactionsTable.createdAt, query.before));
  }

  return db
    .select()
    .from(walletTransactionsTable)
    .where(and(...conditions))
    .orderBy(desc(walletTransactionsTable.createdAt))
    .limit(query.limit);
}
