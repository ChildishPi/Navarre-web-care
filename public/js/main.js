/* =========================================================
   Navarre Web Care — Main Application JavaScript
   Handles UI interactions, navigation, header scroll shadow,
   smooth scrolling, and section reveal animations.
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {
  // Mobile Navigation Menu Toggle
  const navToggle = document.querySelector(".nav-toggle");
  const siteNav = document.querySelector(".site-nav");

  if (navToggle && siteNav) {
    navToggle.addEventListener("click", () => {
      const isExpanded = navToggle.getAttribute("aria-expanded") === "true";
      navToggle.setAttribute("aria-expanded", !isExpanded);
      siteNav.classList.toggle("site-nav--open");
    });

    // Close menu when a navigation link is clicked
    siteNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        navToggle.setAttribute("aria-expanded", "false");
        siteNav.classList.remove("site-nav--open");
      });
    });
  }

  // Header scroll state indicator
  const header = document.querySelector(".site-header");
  if (header) {
    const onScroll = () => {
      if (window.scrollY > 15) {
        header.classList.add("site-header--scrolled");
      } else {
        header.classList.remove("site-header--scrolled");
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // CTA Smooth scroll to packages section
  const ctaBtn = document.getElementById("cta-view-packages");
  if (ctaBtn) {
    ctaBtn.addEventListener("click", (e) => {
      const targetId = ctaBtn.getAttribute("href");
      if (targetId && targetId.startsWith("#")) {
        e.preventDefault();
        const targetEl = document.querySelector(targetId);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
          try {
            ctaBtn.animate(
              [{ transform: "scale(1)" }, { transform: "scale(1.05)" }, { transform: "scale(1)" }],
              { duration: 300, easing: "ease-out" },
            );
          } catch (err) {
            // Animation fallback
          }
        }
      }
    });
  }

  // Intersection Observer for Section Reveal Animations
  const revealElements = document.querySelectorAll(".reveal");
  if (revealElements.length > 0) {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion || !("IntersectionObserver" in window)) {
      revealElements.forEach((el) => el.classList.add("reveal--visible"));
    } else {
      const revealObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("reveal--visible");
              revealObserver.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.1, rootMargin: "0px 0px -30px 0px" },
      );

      revealElements.forEach((el) => revealObserver.observe(el));
    }
  }
});
