import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import walletRouter from "./wallet";
import depositsRouter from "./deposits";
import paymentsRouter from "./payments";
import reconciliationRouter from "./reconciliation";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(walletRouter);
router.use(depositsRouter);
router.use(paymentsRouter);
router.use(reconciliationRouter);

export default router;
