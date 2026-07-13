## Contact proxy (Node.js)

IMPORTENT FOR JP
This small Express server accepts POST requests at `/send-contact` and sends them to the @ specified by `DEST_EMAIL` using SMTP (nodemailer).

Setup

1. Copy `.env.example` to `.env` and fill in `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, and optionally `DEST_EMAIL`.
2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

4. Run the static site (open `index.html`) and the contact form will POST to `http://localhost:3000/send-contact` by default.

## Custom domain (apex → www)

DNS for the apex record is set at your registrar/host, not in this code — if
`navarrewebcare.com` still resolves to an old parking IP, update it there
(add the root domain in Railway's custom-domain settings, or point the apex
at `www` via CNAME/ALIAS/redirect).

Once traffic reaches this server, it handles canonicalization for you: set
the `CANONICAL_HOST` env var (e.g. `www.navarrewebcare.com`) and the server
301-redirects any other public host — including the bare apex — to that host
over https, and upgrades any `http://` request to `https://`. `localhost`,
`127.0.0.1`, and the platform's internal hostnames (`*.railway.app`,
`*.railway.internal`) are exempt so local dev and healthchecks keep working.

### Cloudflare in front (fixing the 522)

The domain is proxied through Cloudflare. A Cloudflare **error 522** means
Cloudflare answered the visitor but couldn't reach the origin — i.e. the DNS
record behind the orange cloud still points at the dead parking IP
(`162.255.119.87`). Fix it in the Cloudflare dashboard:

1. **Railway → Settings → Networking**: add `www.navarrewebcare.com` (and
   optionally `navarrewebcare.com`) as custom domains. Railway shows a
   `*.up.railway.app` CNAME target for each.
2. **Cloudflare → DNS**: delete the `A navarrewebcare.com → 162.255.119.87`
   record. Add `CNAME www → <target>.up.railway.app`, and for the apex either
   `CNAME @ → <target>.up.railway.app` (Cloudflare flattens apex CNAMEs) or a
   Cloudflare Redirect Rule sending `navarrewebcare.com/*` to
   `https://www.navarrewebcare.com/$1`.
3. **Cloudflare → SSL/TLS**: set the mode to **Full (strict)** — never
   "Flexible". (The app tolerates Flexible without redirect-looping by
   reading the `CF-Visitor` header, but Flexible leaves the Cloudflare→origin
   leg unencrypted.)
4. **Railway → Variables**: `CANONICAL_HOST=www.navarrewebcare.com` and
   `TRUST_PROXY_HOPS=2` (Cloudflare + Railway = two proxy hops; without it
   the contact-form rate limiter can't see real visitor IPs).

## News aggregator

This server also provides a `/news` endpoint that aggregates RSS/JSON feeds and returns a unified JSON payload for the client to consume.

- Configure feed sources via the `NEWS_FEEDS` env var (comma-separated list of feed URLs). If not set, the server uses Google News search RSS feeds for Navarre, Milton, Gulf Breeze, and Fort Walton Beach by default.
- The endpoint is cached for `FETCH_CACHE_TTL` milliseconds (default 300000 = 5 minutes) to reduce fetch load.

Example: GET `http://localhost:3000/news` returns `{ items: [ { title, link, pubDate, source, summary }, ... ] }`.

Security

- Use a trusted SMTP provider and keep credentials secret.
- Consider deploying this server behind HTTPS and adding rate-limiting or CAPTCHA for production.
