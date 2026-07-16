import { Router, type IRouter } from "express";
import {
  ConvertWinningToPlayBody,
  ConvertWinningToPlayResponse,
  GetWalletBalanceResponse,
  GetWalletTransactionsQueryParams,
  GetWalletTransactionsResponse,
} from "@workspace/api-zod";
import { requireSession } from "../middlewares/requireSession";
import {
  InsufficientBalanceError,
  getWalletAccountsForUser,
  getWalletTransactions,
  convertWinningToPlay,
  type WalletType,
} from "../lib/wallet";

const router: IRouter = Router();

function balancesFromAccounts(accounts: { walletType: WalletType; balance: number }[]) {
  const playCoins = accounts.find((account) => account.walletType === "play_coins");
  const winningCoins = accounts.find((account) => account.walletType === "winning_coins");

  if (!playCoins || !winningCoins) {
    throw new Error("User is missing one or both wallet accounts.");
  }

  return { playCoins: playCoins.balance, winningCoins: winningCoins.balance };
}

router.get("/wallet/balance", requireSession, async (req, res): Promise<void> => {
  const accounts = await getWalletAccountsForUser(req.user!.id);
  res.status(200).json(GetWalletBalanceResponse.parse(balancesFromAccounts(accounts)));
});

router.get("/wallet/transactions", requireSession, async (req, res): Promise<void> => {
  const parsed = GetWalletTransactionsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const { walletType, limit, before } = parsed.data;

  const accounts = await getWalletAccountsForUser(req.user!.id);
  const account = accounts.find((candidate) => candidate.walletType === walletType);

  if (!account) {
    throw new Error("User is missing the requested wallet account.");
  }

  const transactions = await getWalletTransactions({
    walletAccountId: account.id,
    limit,
    before,
  });

  res.status(200).json(GetWalletTransactionsResponse.parse({ transactions }));
});

router.post("/wallet/convert", requireSession, async (req, res): Promise<void> => {
  const parsed = ConvertWinningToPlayBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.message });
    return;
  }

  const { amount, idempotencyKey } = parsed.data;

  try {
    const result = await convertWinningToPlay(req.user!.id, amount, idempotencyKey);
    res.status(200).json(
      ConvertWinningToPlayResponse.parse({
        playCoins: result.playCoinsBalance,
        winningCoins: result.winningCoinsBalance,
      }),
    );
  } catch (error) {
    if (error instanceof InsufficientBalanceError) {
      res.status(400).json({ message: error.message });
      return;
    }
    throw error;
  }
});

export default router;
