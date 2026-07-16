import type { AuthenticatedUser } from "../middlewares/requireSession";

// Augments Express's Request type so authenticated route handlers can read
// `req.user` after `requireSession` has run, without unsafe casts.
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
