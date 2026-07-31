// Rate limiters keyed on a hashed client identifier instead of the raw IP
// express-rate-limit uses by default. Same throttling behavior, but the
// in-memory store never holds a plaintext IP.
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { hashIdentifier } = require("./hash");

// ipKeyGenerator (express-rate-limit v8) buckets IPv6 clients by /56 subnet
// before we hash — otherwise one visitor rotating through their practically
// unlimited IPv6 addresses gets a fresh rate-limit bucket per address.
function hashKeyGenerator(req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  return hashIdentifier(ipKeyGenerator(ip, 56));
}

// Applied globally in server.js — a loose ceiling so normal browsing and
// asset loading never trips it, but a scripted hammering of the site does.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || "120", 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: hashKeyGenerator,
  message: { ok: false, error: "too-many-requests" },
});

// Factory for tighter, route-specific limits (e.g. the contact form).
function strictLimiter({ windowMs = 15 * 60 * 1000, max = 5 } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: hashKeyGenerator,
    message: { ok: false, error: "too-many-requests" },
  });
}

module.exports = { globalLimiter, strictLimiter, hashKeyGenerator };
