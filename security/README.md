# security/

Three pieces, all wired into `server.js`:

**hash.js** — salts and SHA-256-hashes client IPs. Nothing downstream
(rate limiter store, honeypot strike map, logs) ever holds a plaintext IP.
Set `SECURITY_SALT` in Railway; the built-in fallback is dev-only.

**hashRateLimiter.js** — `express-rate-limit` wrappers keyed on the hashed
IP instead of the raw one. `globalLimiter` is mounted on every route
(`RATE_LIMIT_MAX`/min, default 120). `strictLimiter()` is a factory for
tighter per-route limits — the contact form uses it for 5/15min, same as
before.

**honeypot.js** — bait routes for paths scanners probe on nearly every
public IP (`/.env`, `/wp-login.php`, `/phpmyadmin`, `/.git/config`, ...).
Mounted before `express.static` so these are matched even though
`dotfiles:"ignore"` would otherwise silently 404 `/.env`-style paths.
Every hit is logged (`console.warn`, visible in Railway logs) and counted;
after `HONEYPOT_STRIKE_LIMIT` hits (default 1) the hashed IP is blocked
for `HONEYPOT_BLOCK_MS` (default 24h) via `blocklistGuard`, which runs
first in the middleware chain and drops the connection with a bare 403.

The `/.env`-style bait paths serve `.env.backup` — a decoy file at the
project root with fake SMTP/API/Railway credentials. It's intentionally
**not** in `.gitignore`, so it also functions as bait if the repo itself
leaks. The real `.env` stays gitignored and is never served
(`express.static` blocks all dotfiles except the deliberate honeypot
exceptions above).

This is in-memory only — strikes/blocks reset on every redeploy or
restart. Fine for a single Railway instance; swap in Redis if that
changes.

Complements the existing hidden-field honeypot on the contact form in
`server.js` (the `company`/`honeypot` input), which catches form-spam
bots rather than path-scanning ones.
