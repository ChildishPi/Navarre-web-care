require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files (the site) from the project root so the site is available at /
app.use(express.static(path.join(__dirname)));

// Ensure root serves the main HTML file
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "Main-index-updated.html")),
);

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

const fetch = require("node-fetch");
const xml2js = require("xml2js");

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

app.post("/send-contact", async (req, res) => {
  try {
    const { email, message, company, honeypot } = req.body || {};

    // Basic anti-spam: reject if honeypot filled
    if (honeypot) return res.status(400).json({ ok: false, error: "spam" });
    if (!email || !message)
      return res.status(400).json({ ok: false, error: "missing" });

    const transporter = createTransporter();
    if (!transporter)
      return res.status(500).json({ ok: false, error: "no-smtp-config" });

    const subject = `Website contact from ${email}`;
    const body = `Email: ${email}\nCompany: ${company || ""}\n\nMessage:\n${message}`;

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || email,
      to: DEST_EMAIL,
      subject,
      text: body,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("send-contact error", err);
    return res.status(500).json({ ok: false, error: "server" });
  }
});

app.listen(PORT, () =>
  console.log(`Contact proxy listening on http://localhost:${PORT}`),
);
