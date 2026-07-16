import { Router, type IRouter } from "express";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import { requireSession } from "../middlewares/requireSession";

const router: IRouter = Router();

router.get("/users/me", requireSession, (req, res): void => {
  // requireSession guarantees req.user is set before next() is called.
  res.status(200).json(GetCurrentUserResponse.parse(req.user));
});

export default router;
