/* =========================================================
   Navarre Web Care — News Feed Proxy Scroller Widget
   Fetches aggregated news securely from /news endpoint and
   renders ticker with pause-on-hover & accessibility support.
   ========================================================= */

(function () {
  const scroller = document.getElementById("newsScroller");
  if (!scroller) return;

  let paused = false;
  scroller.addEventListener("mouseenter", () => (paused = true));
  scroller.addEventListener("mouseleave", () => (paused = false));
  scroller.addEventListener("focus", () => (paused = true));
  scroller.addEventListener("blur", () => (paused = false));

  function populateItems(items) {
    const ul = scroller.querySelector("ul") || document.createElement("ul");
    ul.className = "dispatch__list";
    ul.innerHTML = "";

    items.forEach((it) => {
      const li = document.createElement("li");
      li.className = "dispatch__item";

      if (it.titlePrefix) {
        const strong = document.createElement("strong");
        strong.className = "dispatch__tag";
        strong.textContent = it.titlePrefix;
        li.appendChild(strong);
        li.appendChild(document.createTextNode(" "));
      }

      const span = document.createElement("span");
      if (it.link && /^https?:\/\//i.test(it.link)) {
        const a = document.createElement("a");
        a.href = it.link;
        a.textContent = it.text || it.title || it.link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        span.appendChild(a);
      } else {
        span.textContent = it.text || it.title || "";
      }

      li.appendChild(span);
      ul.appendChild(li);
    });

    if (!scroller.querySelector("ul")) {
      scroller.appendChild(ul);
    }
    scroller.scrollTop = 0;
  }

  async function fetchFeeds() {
    const DEFAULT_API_BASE = "http://localhost:3000";
    const pageOrigin = (window.location && window.location.origin) || "";
    const apiBase =
      window.location.protocol === "file:" || !pageOrigin || pageOrigin === "null"
        ? DEFAULT_API_BASE
        : pageOrigin;
    const endpoint = apiBase.replace(/\/$/, "") + "/news";

    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error("network response " + res.status);
      const data = await res.json();
      const items = (data.items || []).slice(0, 15).map((it) => ({
        title: it.title || "",
        link: it.link || "",
        text: it.title || it.summary || "",
      }));

      if (items.length > 0) {
        populateItems(items);
        return true;
      }
    } catch (err) {
      console.warn("Server news fetch notice:", err && err.message);
    }
    return false;
  }

  fetchFeeds().then((ok) => {
    if (!ok) {
      console.info("Using static news feed fallback items.");
    }
  });

  const STEP = 1;
  const INTERVAL = 25;

  function tick() {
    if (paused) return;
    if (scroller.scrollHeight - scroller.clientHeight <= 0) return;
    scroller.scrollTop += STEP;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) {
      scroller.scrollTop = 0;
    }
  }

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (prefersReducedMotion && prefersReducedMotion.matches) return;

  const timerId = setInterval(tick, INTERVAL);
  scroller.dataset._autoScrollId = timerId;
})();
