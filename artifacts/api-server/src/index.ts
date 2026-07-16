import app from "./app";
import { logger } from "./lib/logger";

// ── PORT ──────────────────────────────────────────────────────────────────────

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── PayU startup validation ───────────────────────────────────────────────────
// All required PayU variables are checked before the server begins accepting
// requests.  Only variable *names* are ever passed to the logger — secret
// values (PAYU_KEY, PAYU_SALT) are never read or printed here.

const PAYU_REQUIRED = ["PAYU_KEY", "PAYU_SALT", "PAYU_SURL", "PAYU_FURL"] as const;

for (const varName of PAYU_REQUIRED) {
  if (!process.env[varName]) {
    logger.fatal(
      "PayU configuration invalid.\n" +
        `Missing environment variable: ${varName}\n` +
        "Server startup aborted.",
    );
    process.exit(1);
  }
}

// PAYU_ENV is optional but, when present, must be one of the two known values.
// Its value is not a secret — logging it on misconfiguration is safe.
const payuEnv = process.env["PAYU_ENV"] ?? "test";
if (payuEnv !== "test" && payuEnv !== "production") {
  logger.fatal(
    "PayU configuration invalid.\n" +
      `PAYU_ENV must be "test" or "production", got "${payuEnv}".\n` +
      "Server startup aborted.",
  );
  process.exit(1);
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
