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
 * Thrown when a debit would succeed against the total settled balance but
 * would dip into coins that are locked by an active reservation. The caller
 * should surface this to the user as "some of your balance is reserved for
 * a pending withdrawal or hold" rather than "you don't have enough coins".
 */
export class InsufficientAvailableBalanceError extends Error {
  constructor(walletType: WalletType) {
    super(
      `Insufficient available ${walletType} balance. ` +
        `Some coins are reserved by an active hold (e.g. a pending withdrawal).`,
    );
    this.name = "InsufficientAvailableBalanceError";
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
 * total settled balance negative.
 *
 * Throws `InsufficientAvailableBalanceError` if applying `amount` would
 * take the settled balance below the currently reserved amount. This guards
 * against spending coins that are locked by an active reservation (e.g. a
 * pending withdrawal hold). The DB `balance >= reserved_balance` CHECK
 * constraint is the backstop of last resort; this check provides the clean
 * application error before that constraint can fire.
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

  // For debits: ensure the resulting balance would not dip below the portion
  // already locked by active reservations. For credits (positive amount),
  // balanceAfter > balance >= reservedBalance, so this check always passes.
  if (balanceAfter < account.reservedBalance) {
    throw new InsufficientAvailableBalanceError(account.walletType);
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

/**
 * A per-coin-type balance snapshot, enriched with reservation data.
 * available = balance - reserved (freely spendable).
 */
export interface CoinBalance {
  balance: number;
  reserved: number;
  available: number;
}

export interface ConversionResult {
  debitTransaction: WalletTransaction;
  creditTransaction: WalletTransaction;
  playCoins: CoinBalance;
  winningCoins: CoinBalance;
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
 *
 * Throws `InsufficientAvailableBalanceError` if the requested amount would
 * spend coins that are locked by an active reservation. This is checked
 * inside `recordCompletedTransaction` under the FOR UPDATE lock, so there
 * is no TOCTOU gap between "check available balance" and "apply debit".
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

    // recordCompletedTransaction re-acquires the lock on winningAccount (same
    // tx, same row — allowed). It checks both balanceAfter >= 0 and
    // balanceAfter >= account.reservedBalance, so reserved coins can never
    // be spent by a conversion.
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

    // reservedBalance on winningAccount is unchanged by this conversion
    // (recordCompletedTransaction never touches reserved_balance), so the
    // value locked before the debit is still valid for the available calc.
    // Play Coins never have reservations, so playAccount.reservedBalance = 0.
    return {
      debitTransaction,
      creditTransaction,
      playCoins: {
        balance: creditTransaction.balanceAfter,
        reserved: playAccount.reservedBalance,
        available: creditTransaction.balanceAfter - playAccount.reservedBalance,
      },
      winningCoins: {
        balance: debitTransaction.balanceAfter,
        reserved: winningAccount.reservedBalance,
        available: debitTransaction.balanceAfter - winningAccount.reservedBalance,
      },
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
