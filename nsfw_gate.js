// NSFW Age-Gate Bypass — runs at document_start
// Kills the "Mature Content" modal, removes backdrop + blur, restores scroll.
(function () {
  "use strict";

  // --- 1. Set the over18 cookie ---
  document.cookie =
    "over18=1; domain=.reddit.com; path=/; max-age=31536000; SameSite=Lax; Secure";

  // --- 2. Nuke the age gate ---

  function restoreScroll() {
    if (document.body) {
      document.body.style.removeProperty("overflow");
      document.body.style.removeProperty("overflow-y");
      document.body.style.removeProperty("position");
      document.body.classList.remove("scroll-disabled");
    }
    if (document.documentElement) {
      document.documentElement.style.removeProperty("overflow");
    }
  }

  function removeBlur() {
    // Remove CSS blur/filter from ALL elements that have it.
    // Reddit blurs the content behind the age gate modal.
    document.querySelectorAll("*").forEach((el) => {
      const style = getComputedStyle(el);
      if (style.filter && style.filter !== "none") {
        el.style.setProperty("filter", "none", "important");
      }
      if (style.webkitFilter && style.webkitFilter !== "none") {
        el.style.setProperty("-webkit-filter", "none", "important");
      }
    });
  }

  // Inject a persistent style rule to block blur and common overlay patterns.
  // This prevents Reddit from re-applying blur after we remove it.
  function injectAntiGateCSS() {
    if (document.getElementById("nsfw-gate-bypass-css")) return;
    const style = document.createElement("style");
    style.id = "nsfw-gate-bypass-css";
    style.textContent = [
      // Kill blur on everything
      "body.scroll-disabled { overflow: auto !important; position: static !important; }",
      // Common Reddit overlay backdrop patterns
      ".overlay-backdrop { display: none !important; }",
      // Ensure the main content is never blurred
      "shreddit-app { filter: none !important; -webkit-filter: none !important; }",
      // Kill all xpromo elements (QR code popup, app nags, etc.)
      '[class*="xpromo"] { display: none !important; }',
      '[data-testid*="xpromo"] { display: none !important; }',
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  }

  function isGateText(text) {
    const t = text.toLowerCase();
    return (
      t.includes("mature content") ||
      t.includes("confirm your age") ||
      t.includes("i'm not over 18") ||
      t.includes("over 18") ||
      t.includes("browse anonymously")
    );
  }

  function nukeAgeGate() {
    let killed = false;

    // Strategy A: Find "Mature Content" text, walk up to the modal container
    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) =>
          n.textContent.includes("Mature Content")
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      }
    );

    let textNode;
    while ((textNode = walker.nextNode())) {
      let el = textNode.parentElement;
      // Walk up to find the outermost fixed/overlay container
      let candidate = null;
      while (el && el !== document.body && el !== document.documentElement) {
        const style = getComputedStyle(el);
        if (
          style.position === "fixed" ||
          style.position === "absolute" ||
          el.getAttribute("role") === "dialog" ||
          el.tagName.toLowerCase().includes("overlay") ||
          el.tagName.toLowerCase().includes("modal") ||
          el.tagName.toLowerCase().includes("interstitial")
        ) {
          candidate = el;
          // Keep walking — we want the OUTERMOST overlay container
        }
        el = el.parentElement;
      }
      if (candidate) {
        candidate.remove();
        killed = true;
      }
    }

    // Strategy B: Nuke any high-z-index fixed overlays that look like backdrops
    document
      .querySelectorAll("div, section, aside, dialog, shreddit-overlay")
      .forEach((el) => {
        try {
          const style = getComputedStyle(el);
          if (style.position !== "fixed") return;
          const z = parseInt(style.zIndex) || 0;
          if (z < 5) return;

          // Empty or near-empty fixed overlay = backdrop
          const text = (el.innerText || "").trim();
          if (text.length === 0 || isGateText(text)) {
            el.remove();
            killed = true;
          }
        } catch (_) {}
      });

    // Strategy C: Selector-based fallback
    document
      .querySelectorAll(
        [
          'shreddit-async-loader[bundlename*="over18"]',
          'shreddit-async-loader[bundlename*="nsfw"]',
          'shreddit-async-loader[bundlename*="mature"]',
          '[data-testid="content-gate"]',
          '[data-testid="over-18-page"]',
          '[data-testid="nsfw-interstitial"]',
          ".interstitial",
          'form[action*="over18"]',
          "xpromo-nsfw-blocking-container",
          '[class*="xpromo"]',
          '[data-testid*="xpromo"]',
        ].join(",")
      )
      .forEach((el) => {
        el.remove();
        killed = true;
      });

    // Strategy D: Kill the "Want to browse anonymously?" QR code popup.
    // Reddit uses various xpromo elements — also catch by tag prefix.
    document.querySelectorAll("*").forEach((el) => {
      const tag = el.tagName?.toLowerCase() || "";
      if (tag.startsWith("xpromo")) {
        el.remove();
        killed = true;
      }
    });

    if (killed) {
      removeBlur();
      restoreScroll();
    }

    // Always try to remove blur — Reddit may apply it without a removable modal
    // (e.g. CSS-only gate on the content)
    removeBlur();
    restoreScroll();
    injectAntiGateCSS();

    return killed;
  }

  // --- 3. Observer + timed scans ---

  function startObserver(target) {
    let timer = null;
    const observer = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        nukeAgeGate();
      }, 50);
    });
    observer.observe(target, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
    return observer;
  }

  function boot() {
    injectAntiGateCSS();
    nukeAgeGate();

    // Retry — Reddit hydrates the modal client-side after initial render
    setTimeout(nukeAgeGate, 100);
    setTimeout(nukeAgeGate, 300);
    setTimeout(nukeAgeGate, 600);
    setTimeout(nukeAgeGate, 1200);
    setTimeout(nukeAgeGate, 2500);
  }

  // Start observer as early as possible
  if (document.documentElement) {
    startObserver(document.documentElement);
  } else {
    const earlyObs = new MutationObserver(() => {
      if (document.documentElement) {
        earlyObs.disconnect();
        startObserver(document.documentElement);
      }
    });
    earlyObs.observe(document, { childList: true });
  }

  // Run main logic once body exists
  if (document.body) {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
