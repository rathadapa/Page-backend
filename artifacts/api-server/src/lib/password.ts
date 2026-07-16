import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

// `util.promisify` can't infer the options-argument overload of `scrypt`, so
// wrap it explicitly instead of casting away type safety.
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

// scrypt is used because it is a memory-hard KDF built into Node's core
// `crypto` module — no native addon (e.g. bcrypt/argon2) is required, which
// keeps the production build's esbuild bundling and AWS EC2 deployment
// simple. The algorithm identifier is stored alongside the hash (see the
// `users.password_algo` column) so it can be migrated later without
// invalidating existing password hashes.
export const PASSWORD_ALGO = "scrypt" as const;

const SALT_BYTES = 16;
const KEY_LENGTH = 64;

// OWASP-recommended production scrypt cost parameters. `maxmem` must be
// raised to accommodate them — scrypt needs roughly `128 * N * r` bytes
// (~128 MiB here), well above Node's 32 MiB default — with headroom so the
// exact figure isn't a hard boundary.
const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 };
const SCRYPT_OPTIONS = { ...SCRYPT_PARAMS, maxmem: 256 * 1024 * 1024 };

/**
 * Hashes a plaintext password using scrypt with a random salt.
 * Returns a single string of the form `<saltHex>:<hashHex>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS)) as Buffer;
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

/**
 * Verifies a plaintext password against a hash produced by `hashPassword`.
 * Uses a constant-time comparison to avoid leaking timing information.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [saltHex, keyHex] = storedHash.split(":");
  if (!saltHex || !keyHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const expectedKey = Buffer.from(keyHex, "hex");
  const derivedKey = (await scrypt(
    password,
    salt,
    expectedKey.length,
    SCRYPT_OPTIONS,
  )) as Buffer;

  if (derivedKey.length !== expectedKey.length) {
    return false;
  }

  return timingSafeEqual(derivedKey, expectedKey);
}
