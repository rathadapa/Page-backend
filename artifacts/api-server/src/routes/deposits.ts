import { Router, type IRouter } from "express";
import { InitiateDepositBody, InitiateDepositResponse } from "@workspace/api-zod";
import { requireSession } from "../middlewares/requireSession";
import { initiateDeposit } from "../lib/deposit";

const router: IRouter = Router();

router.post("/deposits/initiate", requireSession, async (req, res): Promise<void> => {
  const user = req.user!;

  // Validation order follows the spec:
  //
  // 1. Account active — guaranteed by requireSession, which returns 401 for
  //    any session belonging to a non-active user before this handler runs.
  //
  // 2. Mobile number must be present.
  if (!user.mobileNumber) {
    res.status(400).json({
      code: "MOBILE_NUMBER_REQUIRED",
      message: "A verified mobile number is required before initiating a deposit.",
    });
    return;
  }

  // 3. Mobile number must be verified.
  if (user.mobileVerificationStatus !== "verified") {
    res.status(400).json({
      code: "MOBILE_VERIFICATION_REQUIRED",
      message: "Your mobile number must be verified before initiating a deposit.",
    });
    return;
  }

  // 4. Email must be present.
  if (!user.email) {
    res.status(400).json({
      code: "EMAIL_REQUIRED",
      message: "An email address is required before initiating a deposit.",
    });
    return;
  }

  // 5. Amount must be one of the fixed deposit packages.
  //    InitiateDepositBody has a single field (`amount`) validated as a union
  //    of literals, so any safeParse failure is an invalid amount.
  const parsed = InitiateDepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      code: "INVALID_DEPOSIT_AMOUNT",
      message: "Amount must be one of: ₹50, ₹100, ₹200, ₹500, ₹1000, ₹2000, ₹5000.",
    });
    return;
  }

  const result = await initiateDeposit({
    userId: user.id,
    name: user.name,
    email: user.email,
    phone: user.mobileNumber,
    amount: parsed.data.amount,
  });

  res.status(201).json(
    InitiateDepositResponse.parse({
      deposit: result.deposit,
      payuFormParams: result.payuFormParams,
      paymentUrl: result.paymentUrl,
    }),
  );
});

export default router;
