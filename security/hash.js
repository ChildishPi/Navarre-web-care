// Shared identifier hashing for the security modules in this folder.
//
// Rate limiting and honeypot strike-tracking both need a per-client key,
// but storing raw IP addresses in memory/logs is unnecessary exposure if
// those logs ever leak. Hash everything through here instead so the only
// thing that ever sits in memory or console output is a salted SHA-256
// digest, not a plaintext IP.
const crypto = require("crypto");

// Set SECURITY_SALT in the real environment (Railway variables). The
// fallback keeps `npm start` working locally without extra setup, but
// never rely on it in production — anyone who knows the fallback string
// can brute-force common IPs back out of the hashes.
const SALT = process.env.SECURITY_SALT || "dev-only-salt-change-me";

function hashIdentifier(value) {
  return crypto
    .createHash("sha256")
    .update(SALT + ":" + String(value))
    .digest("hex");
}

module.exports = { hashIdentifier };
