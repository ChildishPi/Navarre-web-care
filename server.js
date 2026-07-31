require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const nodemailer = require("nodemailer");
const path = require("path");
const xml2js = require("xml2js");

// Hash-based rate limiting + the path-scanner honeypot.
const { globalLimiter, strictLimiter } = require("./security/hashRateLimiter");
const { router: honeypotRouter, blocklistGuard } = require("./security/honeypot");

const app = express();
const PORT = process.env.PORT || 3000;

// Drop requests from clients flagged by honeypot before any route processing
app.use(blocklistGuard);

// Trust proxy for rate limiting behind reverse proxies (Railway, Cloudflare, etc.)
app.set("trust proxy", parseInt(process.env.TRUST_PROXY_HOPS || "1", 10));

// Hardened Security Headers with Helmet & CSP
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "https://images.pexels.com", "https://images.unsplash.com", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 63072000,
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

// Honeypot traps
app.use(honeypotRouter);

// Global rate limiting
app.use(globalLimiter);

// Canonical Host & HTTPS Enforcement
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

  const cfVisitor = req.headers["cf-visitor"];
  const visitorIsHttps =
    req.secure || (typeof cfVisitor === "string" && cfVisitor.includes('"scheme":"https"'));

  const targetHost = (CANONICAL_HOST || host).toLowerCase();
  if (visitorIsHttps && host === targetHost) return next();

  return res.redirect(301, "https://" + targetHost + req.originalUrl);
});

// Request body parser limit
app.use(express.json({ limit: "10kb" }));

// Serve static files securely (disallowing dotfiles)
app.use(
  express.static(path.join(__dirname, "public"), {
    dotfiles: "ignore",
    maxAge: "4h",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

const DEST_EMAIL = process.env.DEST_EMAIL || "jp3303@protonmail.com";

const NEWS_FEEDS = (process.env.NEWS_FEEDS && process.env.NEWS_FEEDS.split(",")) || [
  "https://news.google.com/rss/search?q=Navarre+Florida&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Milton+Florida&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Gulf+Breeze+Florida&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Fort+Walton+Beach+Florida&hl=en-US&gl=US&ceid=US:en",
];

const FETCH_CACHE_TTL = parseInt(process.env.FETCH_CACHE_TTL || "300000", 10);
const cache = { ts: 0, data: null };

function htmlToText(value) {
  const raw = typeof value === "string" ? value : (value && value._) || "";
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAndParse(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error("bad response " + res.status);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();

    if (ct.includes("application/json") || url.endsWith(".json")) {
      const data = JSON.parse(text);
      return (data.items || []).map((it) => ({
        title: it.title || "",
        link: it.url || it.external_url || it.link || "",
        pubDate: it.date_published || it.pubDate || null,
        source: data.title || url,
        summary: it.summary || it.content_text || "",
      }));
    }

    const parsed = await xml2js.parseStringPromise(text, {
      explicitArray: false,
    });
    let items = [];
    if (parsed && parsed.rss && parsed.rss.channel && parsed.rss.channel.item) {
      const raw = parsed.rss.channel.item;
      const list = Array.isArray(raw) ? raw : [raw];
      items = list.map((i) => ({
        title: i.title || "",
        link: (i.link && (typeof i.link === "object" ? i.link._ : i.link)) || i.link || "",
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
        source: (parsed.feed.title && (parsed.feed.title._ || parsed.feed.title)) || url,
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
        title: htmlToText(it.title),
        link: /^https?:\/\//i.test(it.link || "") ? it.link : "",
        pubDate: it.pubDate ? new Date(it.pubDate).toISOString() : null,
        source: htmlToText(it.source),
        summary: htmlToText(it.summary),
      }));

    items.sort((a, b) => {
      if (a.pubDate && b.pubDate) return new Date(b.pubDate) - new Date(a.pubDate);
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
    secure: port === 465,
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

const contactLimiter = strictLimiter({ windowMs: 15 * 60 * 1000, max: 5 });

app.post("/send-contact", contactLimiter, async (req, res) => {
  try {
    const { name, phone, email, message, company, honeypot } = req.body || {};

    if (company || honeypot) return res.json({ ok: true });

    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanPhone = typeof phone === "string" ? phone.trim() : "";
    const cleanEmail = typeof email === "string" ? email.trim() : "";
    const cleanMessage = typeof message === "string" ? message.trim() : "";

    const isWillForm = Boolean(cleanName && cleanPhone);
    const isNwcForm = Boolean(cleanEmail && cleanMessage);

    if (!isWillForm && !isNwcForm) return res.status(400).json({ ok: false, error: "missing" });

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
  console.log(`Navarre Web Care contact proxy listening on http://localhost:${PORT}`),
);
