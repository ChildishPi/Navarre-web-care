require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const path = require("path");

// node-fetch v2 (require() syntax). The `timeout` option below is v2-only —
// if you ever upgrade to v3 (ESM), switch to an AbortController.
const fetch = require("node-fetch");
const xml2js = require("xml2js");

const app = express();
const PORT = process.env.PORT || 3000;

// If deployed behind a reverse proxy (nginx, Render, Railway, etc.), this
// lets express-rate-limit see the real client IP instead of the proxy's.
// Each proxy in front of the app adds one hop to X-Forwarded-For:
//   Railway alone            → 1 hop  (default)
//   Cloudflare → Railway     → 2 hops (set TRUST_PROXY_HOPS=2, or the rate
//                              limiter throttles Cloudflare's shared IPs and
//                              blocks whole swaths of real visitors at once)
app.set("trust proxy", parseInt(process.env.TRUST_PROXY_HOPS || "1", 10));

// Security headers, including the CSP previously only in the <meta> tag.
// Server-side enforcement is the primary layer; the meta tag stays as backup.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: [
          "'self'",
          "https://images.pexels.com",
          "https://images.unsplash.com",
          "data:",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // index.html's rate limiter, smooth-scroll, and news-scroller all
        // run from inline <script> blocks and onsubmit="" / onclick=""
        // attributes — no nonce/hash setup exists, so both directives need
        // 'unsafe-inline' or the handlers silently no-op (helmet defaults
        // script-src-attr to 'none', which blocks the attribute handlers
        // even when script-src itself allows inline <script> blocks) and
        // forms fall back to a native GET submit that leaks form fields
        // into the URL.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);

// ---------------------------------------------------------------------------
// Canonical host + HTTPS redirect.
//
// Funnels every public request to one canonical https:// URL. This is what
// makes the bare apex work: set CANONICAL_HOST to "www.navarrewebcare.com"
// and a hit on http(s)://navarrewebcare.com/... 301s to
// https://www.navarrewebcare.com/... — so you can point the apex at www
// (CNAME/redirect) instead of needing an A record at the app itself. It also
// upgrades any plain http:// request to https://.
//
// Leave CANONICAL_HOST unset to only force https on whatever host is used.
// localhost, 127.0.0.1, and the platform's internal hostnames are always
// skipped so local `npm start`, Railway healthchecks, and *.up.railway.app
// preview URLs keep working over http.
// ---------------------------------------------------------------------------
const CANONICAL_HOST = process.env.CANONICAL_HOST;

app.use((req, res, next) => {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();

  const isLocalOrInternal =
    !host ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".railway.app") ||
    host.endsWith(".railway.internal");
  if (isLocalOrInternal) return next();

  // trust proxy (set above) makes req.secure reflect X-Forwarded-Proto.
  // Cloudflare guard: with Cloudflare's SSL mode on "Flexible", Cloudflare
  // fetches the origin over plain http even when the visitor used https —
  // redirecting on req.secure alone would loop forever (origin says "go to
  // https", Cloudflare fetches http again...). CF-Visitor carries the
  // visitor's real scheme, so trust it when present. ("Full (strict)" is
  // still the mode you want in the Cloudflare dashboard.)
  const cfVisitor = req.headers["cf-visitor"];
  const visitorIsHttps =
    req.secure ||
    (typeof cfVisitor === "string" && cfVisitor.includes('"scheme":"https"'));

  const targetHost = (CANONICAL_HOST || host).toLowerCase();
  if (visitorIsHttps && host === targetHost) return next();

  return res.redirect(301, "https://" + targetHost + req.originalUrl);
});

// Cap request body size — the contact form never needs more than a few KB.
app.use(express.json({ limit: "10kb" }));

// NOTE: cors() was removed. The form and the API are same-origin, so CORS
// isn't needed. If you ever need it (e.g. local testing across ports), use:
//   app.use(cors({ origin: "https://your-live-domain.com" }));

// Serve ONLY the public/ folder — never the project root, which would
// expose .env, server.js, and node_modules to anyone who asks for them.
// Move the site files (HTML, css/, js/, images) into ./public
// express.static serves public/index.html automatically for GET "/".
app.use(express.static(path.join(__dirname, "public")));

const DEST_EMAIL = process.env.DEST_EMAIL || "jp3303@protonmail.com";

const NEWS_FEEDS = (process.env.NEWS_FEEDS &&
  process.env.NEWS_FEEDS.split(",")) || [
  "https://news.google.com/rss/search?q=Navarre+Florida&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Milton+Florida&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Gulf+Breeze+Florida&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Fort+Walton+Beach+Florida&hl=en-US&gl=US&ceid=US:en",
];

const FETCH_CACHE_TTL = parseInt(process.env.FETCH_CACHE_TTL || "300000", 10); // 5 minutes
const cache = { ts: 0, data: null };

async function fetchAndParse(url) {
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) throw new Error("bad response " + res.status);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();

    if (ct.includes("application/json") || url.endsWith(".json")) {
      const data = JSON.parse(text);
      const items = (data.items || []).map((it) => ({
        title: it.title || "",
        link: it.url || it.external_url || it.link || "",
        pubDate: it.date_published || it.pubDate || null,
        source: data.title || url,
        summary: it.summary || it.content_text || "",
      }));
      return items;
    }

    // Parse XML/RSS
    const parsed = await xml2js.parseStringPromise(text, {
      explicitArray: false,
    });
    let items = [];
    if (parsed && parsed.rss && parsed.rss.channel && parsed.rss.channel.item) {
      const raw = parsed.rss.channel.item;
      const list = Array.isArray(raw) ? raw : [raw];
      items = list.map((i) => ({
        title: i.title || "",
        link:
          (i.link && (typeof i.link === "object" ? i.link._ : i.link)) ||
          i.link ||
          "",
        pubDate: i.pubDate || i.pubdate || null,
        source: parsed.rss.channel.title || url,
        summary: i.description || "",
      }));
    } else if (parsed && parsed.feed && parsed.feed.entry) {
      const raw = parsed.feed.entry;
      const list = Array.isArray(raw) ? raw : [raw];
      items = list.map((i) => ({
        title: (i.title && (i.title._ || i.title)) || "",
        link: (i.link && i.link.href) || (i.id && i.id._) || "",
        pubDate: i.updated || i.published || null,
        source:
          (parsed.feed.title && (parsed.feed.title._ || parsed.feed.title)) ||
          url,
        summary: i.summary || i.content || "",
      }));
    }

    return items;
  } catch (err) {
    console.warn("fetchAndParse error", url, err && err.message);
    return [];
  }
}

app.get("/news", async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && now - cache.ts < FETCH_CACHE_TTL) {
      return res.json(cache.data);
    }

    const promises = NEWS_FEEDS.map((u) => fetchAndParse(u));
    const results = await Promise.all(promises);
    const items = results
      .flat()
      .filter(Boolean)
      .map((it) => ({
        title: it.title || "",
        link: it.link || "",
        pubDate: it.pubDate ? new Date(it.pubDate).toISOString() : null,
        source: it.source || "",
        summary: it.summary || "",
      }));

    // sort by pubDate descending when available
    items.sort((a, b) => {
      if (a.pubDate && b.pubDate)
        return new Date(b.pubDate) - new Date(a.pubDate);
      if (a.pubDate) return -1;
      if (b.pubDate) return 1;
      return 0;
    });

    const out = {
      items: items.slice(0, 50),
      fetched: new Date().toISOString(),
    };
    cache.ts = Date.now();
    cache.data = out;
    return res.json(out);
  } catch (err) {
    console.error("news endpoint error", err);
    return res.status(500).json({ items: [] });
  }
});

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: { user, pass },
  });
}

async function sendContactEmail({ subject, text, replyTo }) {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn("SMTP not configured; logging contact message instead.");
    console.log("[contact-message]", { subject, replyTo, text });
    return { ok: true, simulated: true };
  }

  await transporter.sendMail({
    from: process.env.FROM_EMAIL || process.env.SMTP_USER,
    to: DEST_EMAIL,
    replyTo: replyTo || undefined,
    subject,
    text,
  });

  return { ok: true, simulated: false };
}

// Rate limit contact submissions: 5 per 15 minutes per IP.
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "too-many-requests" },
});

app.post("/send-contact", contactLimiter, async (req, res) => {
  try {
    // Accepts BOTH contact form shapes:
    //  - Navarre Web Care form: { email, message }
    //  - "Will" Will Do It form: { name, phone, message }
    // "company" (and legacy "honeypot") are hidden honeypot fields
    // real users never fill.
    const { name, phone, email, message, company, honeypot } = req.body || {};

    // Honeypot tripped: return a fake success so bots don't learn
    // they were caught, and send nothing.
    if (company || honeypot) return res.json({ ok: true });

    // Server-side validation — the HTML maxlength/pattern attributes are
    // advisory only and trivially bypassed.
    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanPhone = typeof phone === "string" ? phone.trim() : "";
    const cleanEmail = typeof email === "string" ? email.trim() : "";
    const cleanMessage = typeof message === "string" ? message.trim() : "";

    const isWillForm = Boolean(cleanName && cleanPhone);
    const isNwcForm = Boolean(cleanEmail && cleanMessage);

    if (!isWillForm && !isNwcForm)
      return res.status(400).json({ ok: false, error: "missing" });
    if (
      cleanName.length > 100 ||
      cleanPhone.length > 20 ||
      cleanEmail.length > 254 ||
      cleanMessage.length > 2000
    )
      return res.status(400).json({ ok: false, error: "too-long" });
    if (cleanPhone && !/^[0-9+\-\s()]{7,20}$/.test(cleanPhone))
      return res.status(400).json({ ok: false, error: "bad-phone" });
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))
      return res.status(400).json({ ok: false, error: "bad-email" });

    const subject = isWillForm
      ? `Website estimate request from ${cleanName}`
      : `Website contact from ${cleanEmail}`;
    const bodyLines = [];
    if (cleanName) bodyLines.push(`Name: ${cleanName}`);
    if (cleanPhone) bodyLines.push(`Phone: ${cleanPhone}`);
    if (cleanEmail) bodyLines.push(`Email: ${cleanEmail}`);
    bodyLines.push("", "Message:", cleanMessage || "(none provided)");
    const body = bodyLines.join("\n");

    const result = await sendContactEmail({
      subject,
      text: body,
      replyTo: cleanEmail || undefined,
    });

    return res.json(result);
  } catch (err) {
    console.error("send-contact error", err);
    return res.status(500).json({ ok: false, error: "server" });
  }
});

app.listen(PORT, () =>
  console.log(`Contact proxy listening on http://localhost:${PORT}`),
);
