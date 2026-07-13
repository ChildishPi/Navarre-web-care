// News ticker for the "Will" Will Do It page.
// Populates #scroller with a horizontally scrolling marquee built from the
// same /news endpoint the Navarre Web Care page uses. Falls back to a
// static message if the feed can't be reached.
(function () {
  const container = document.getElementById("scroller");
  if (!container) return;

  const DEFAULT_API_BASE = "http://localhost:3000";
  const FALLBACK_TEXT =
    "Serving Navarre and the surrounding Gulf Coast — reach out for a free estimate.";
  const SEPARATOR = "   •   ";

  function apiBase() {
    const pageOrigin = (window.location && window.location.origin) || "";
    return window.location.protocol === "file:" ||
      !pageOrigin ||
      pageOrigin === "null"
      ? DEFAULT_API_BASE
      : pageOrigin;
  }

  // Builds one copy of the ticker text as DOM nodes (textContent only —
  // feed titles come from external RSS/JSON and must never be parsed as HTML).
  function buildTrack(items, hidden) {
    const track = document.createElement("span");
    if (hidden) track.setAttribute("aria-hidden", "true");
    items.forEach((it, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.textContent = SEPARATOR;
        track.appendChild(sep);
      }
      const label = document.createElement("span");
      label.textContent =
        (it.source ? it.source + ": " : "") + (it.title || it.summary || "");
      track.appendChild(label);
    });
    return track;
  }

  function render(items) {
    const content = document.createElement("div");
    content.className = "scroller-content";

    if (!items || !items.length) {
      const label = document.createElement("span");
      label.textContent = FALLBACK_TEXT;
      content.appendChild(label);
    } else {
      // Two copies back-to-back so the CSS -50% animation loops seamlessly;
      // the second copy is decorative and hidden from assistive tech.
      content.appendChild(buildTrack(items, false));
      const sep = document.createElement("span");
      sep.textContent = SEPARATOR;
      content.appendChild(sep);
      content.appendChild(buildTrack(items, true));
    }

    container.innerHTML = "";
    container.appendChild(content);
  }

  async function loadNews() {
    try {
      const endpoint = apiBase().replace(/\/$/, "") + "/news";
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error("network");
      const data = await res.json();
      const items = (data.items || []).slice(0, 10);
      render(items);
    } catch (err) {
      console.warn("news ticker: failed to load feed", err);
      render([]);
    }
  }

  loadNews();
})();
