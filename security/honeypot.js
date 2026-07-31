// Honeypot trap for automated scanners.
//
// Real visitors and the real site never touch these paths. Anything that
// requests them is, by definition, a bot probing for common
// misconfigurations (leaked .env, WordPress admin, phpMyAdmin, etc.) — so
// every hit is logged and the client is flagged. This complements the
// hidden-field honeypot already on the contact form in server.js
// (the "company"/"honeypot" input), which catches form-spam bots; this
// module catches path-scanning bots.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { hashIdentifier } = require("./hash");

// --- Strike tracking / blocklist --------------------------------------------
// In-memory only, so it resets on every redeploy/restart. Fine for a
// single small Railway instance; move to a shared store (Redis, etc.) if
// this ever runs more than one instance at once.
const STRIKE_LIMIT = parseInt(process.env.HONEYPOT_STRIKE_LIMIT || "1", 10);
const BLOCK_MS = parseInt(
  process.env.HONEYPOT_BLOCK_MS || String(24 * 60 * 60 * 1000), // 24h
  10,
);

const strikes = new Map(); // hashedIp -> count
const blocked = new Map(); // hashedIp -> unblock-at (epoch ms)

function isBlocked(hashedIp) {
  const until = blocked.get(hashedIp);
  if (!until) return false;
  if (Date.now() > until) {
    blocked.delete(hashedIp);
    strikes.delete(hashedIp);
    return false;
  }
  return true;
}

function registerStrike(hashedIp, meta) {
  const count = (strikes.get(hashedIp) || 0) + 1;
  strikes.set(hashedIp, count);
  console.warn("[honeypot] trap tripped:", JSON.stringify({ hashedIp, count, ...meta }));
  if (count >= STRIKE_LIMIT && !isBlocked(hashedIp)) {
    const until = Date.now() + BLOCK_MS;
    blocked.set(hashedIp, until);
    console.warn(
      "[honeypot] blocking:",
      JSON.stringify({ hashedIp, until: new Date(until).toISOString() }),
    );
  }
}

// Mount FIRST in server.js, ahead of everything else, so a flagged client
// gets dropped before it reaches static files, the rate limiter, or any
// real route.
function blocklistGuard(req, res, next) {
  const hashedIp = hashIdentifier(req.ip || req.socket?.remoteAddress || "unknown");
  req.hashedIp = hashedIp;
  if (isBlocked(hashedIp)) {
    // Bare 403, no body/headers to fingerprint — don't give a blocked
    // client anything more to work with.
    return res.status(403).end();
  }
  next();
}

// --- Bait content ------------------------------------------------------------
// Same decoy file gets served over HTTP here as sits in the repo at
// .env.backup, so a path scan and a repo/backup leak both hand an
// attacker the identical (fake) credentials.
const decoyEnvPath = path.join(__dirname, "..", ".env.backup");

function sendDecoyEnv(res) {
  fs.readFile(decoyEnvPath, "utf8", (err, data) => {
    res
      .status(200)
      .type("text/plain")
      .send(err ? "" : data);
  });
}

// --- Trap routes -------------------------------------------------------------
// Paths bots/scanners probe on nearly every internet-facing IP, none of
// which exist in this app. Mounted BEFORE express.static in server.js so
// these are matched even though express.static's dotfiles:"ignore" would
// otherwise silently 404 dot-paths like /.env (which is the right
// behavior for every OTHER dotfile — this router is the one deliberate
// exception, because a logged, trackable trap beats a silent 404).
const ENV_BAIT_PATHS = [
  "/.env",
  "/.env.bak",
  "/.env.backup",
  "/.env.old",
  "/.env.production",
  "/env.backup",
  "/backup.env",
];

const GENERIC_BAIT_PATHS = [
  "/wp-login.php",
  "/wp-admin",
  // Express 5 (path-to-regexp v8) syntax — a bare "*" is no longer a valid
  // route pattern; wildcards must be named.
  "/wp-admin/*splat",
  "/xmlrpc.php",
  "/.git/config",
  "/.aws/credentials",
  "/config.php",
  "/administrator",
  "/phpmyadmin",
  "/phpMyAdmin",
  "/server-status",
  "/debug",
  "/console",
  "/backup.sql",
  "/database.sql",
];

const router = express.Router();

// Strike middleware must be scoped to the trap routes only. (It was
// previously a bare router.use(), which runs for EVERY request through the
// app — so each real visitor's first page load struck them out and their
// second request got a 403. With trap() wrapping only the bait paths,
// normal traffic never touches the strike tracker.)
function trap(handler) {
  return (req, res) => {
    registerStrike(req.hashedIp || hashIdentifier(req.ip || "unknown"), {
      path: req.originalUrl,
      method: req.method,
      ua: req.headers["user-agent"] || "",
    });
    return handler(req, res);
  };
}

for (const p of ENV_BAIT_PATHS) {
  router.get(
    p,
    trap((req, res) => sendDecoyEnv(res)),
  );
}
for (const p of GENERIC_BAIT_PATHS) {
  router.all(
    p,
    trap((req, res) => res.status(404).type("text/plain").send("Not Found")),
  );
}

module.exports = { router, blocklistGuard };
