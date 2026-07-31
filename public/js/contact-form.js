/* =========================================================
   Navarre Web Care — Contact Form Handler JavaScript
   Handles client-side rate-limiting, honeypot protection,
   validation, and asynchronous submit via /send-contact API.
   ========================================================= */

(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const contactForm = document.getElementById("contactForm");
    if (!contactForm) return;

    contactForm.addEventListener("submit", handleContactSubmit);
  });

  function setFormStatus(element, type, text) {
    if (!element) return;
    element.style.display = "block";
    element.className = `form-status form-status--${type}`;
    element.textContent = text;
  }

  async function handleContactSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const msgEl = document.getElementById("rateLimitMsg");

    const email = (form.email ? form.email.value : "").trim();
    const message = (form.message ? form.message.value : "").trim();
    const company = form.company ? form.company.value : ""; // honeypot

    // Client-side Honeypot Check
    if (company) {
      setFormStatus(msgEl, "success", "✓ Message sent! We'll get back to you soon.");
      form.reset();
      return false;
    }

    if (!email || !message) {
      setFormStatus(msgEl, "error", "⚠️ Please fill in all required fields (Email and Message).");
      return false;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setFormStatus(msgEl, "error", "⚠️ Please enter a valid email address.");
      return false;
    }

    // Rate Limit Check (5 attempts / hour in LocalStorage)
    const MAX_ATTEMPTS = 5;
    const TIME_WINDOW = 60 * 60 * 1000; // 1 hour
    const now = Date.now();

    let attempts = [];
    try {
      attempts = JSON.parse(localStorage.getItem("formAttempts") || "[]");
    } catch (e) {
      attempts = [];
    }

    attempts = attempts.filter((ts) => typeof ts === "number" && now - ts < TIME_WINDOW);

    if (attempts.length >= MAX_ATTEMPTS) {
      const oldestAttempt = attempts[0];
      const resetTime = new Date(oldestAttempt + TIME_WINDOW);
      const remainingMinutes = Math.ceil((resetTime - now) / 60000);

      setFormStatus(
        msgEl,
        "error",
        `⚠️ Too many contact attempts. Please try again in ${remainingMinutes} minute(s).`,
      );
      return false;
    }

    // Record attempt
    attempts.push(now);
    localStorage.setItem("formAttempts", JSON.stringify(attempts));

    setFormStatus(msgEl, "info", "Sending message...");

    const DEFAULT_API_BASE = "http://localhost:3000";
    const pageOrigin = (window.location && window.location.origin) || "";
    const apiBase =
      window.location.protocol === "file:" || !pageOrigin || pageOrigin === "null"
        ? DEFAULT_API_BASE
        : pageOrigin;
    const endpoint = apiBase.replace(/\/$/, "") + "/send-contact";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, message, company }),
      });

      const data = await response.json();

      if (response.ok && data && data.ok) {
        setFormStatus(msgEl, "success", "✓ Message sent! We'll get back to you soon.");
        form.reset();
        setTimeout(() => {
          if (msgEl) msgEl.style.display = "none";
        }, 4000);
      } else {
        const errorMsg =
          data.error === "too-long"
            ? "⚠️ Message or email is too long."
            : "⚠️ Error sending message. Please try again later.";
        setFormStatus(msgEl, "error", errorMsg);
      }
    } catch (err) {
      console.warn("Contact submission failed:", err);
      setFormStatus(
        msgEl,
        "error",
        "⚠️ Network connection issue. Please check your connection and try again.",
      );
    }

    return false;
  }
})();
