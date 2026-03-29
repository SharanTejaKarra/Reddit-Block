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
    // Only remove the PAGE-LEVEL blur that the age gate applies.
    // Do NOT touch individual post/comment elements — they use blur
    // for spoiler text and NSFW content reveal on click.
    const targets = [
      document.documentElement,
      document.body,
      document.querySelector("shreddit-app"),
      document.querySelector("#app"),
      document.querySelector('[id="2x-container"]'),
      document.querySelector("main"),
    ];
    for (const el of targets) {
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.filter && style.filter !== "none") {
        el.style.setProperty("filter", "none", "important");
      }
    }
  }

  // Force-reveal NSFW post content hidden inside shreddit-blurred-container shadow DOMs.
  // The shadow root contains div.outer.h-full with overflow:hidden and height:0px.
  // Page CSS can't pierce shadow boundaries, so we inject styles directly.
  // Track posts we've already fetched content for
  const fetchedPosts = new Set();

  function revealNsfwContent() {
    // Find posts with empty NSFW blurred containers and fetch their content
    document.querySelectorAll("shreddit-post").forEach((post) => {
      const sbc = post.querySelector('shreddit-blurred-container[reason="nsfw"]');
      if (!sbc) return;

      const permalink = post.getAttribute("permalink");
      if (!permalink) return;

      const postId = post.getAttribute("id") || permalink;
      if (fetchedPosts.has(postId)) return;
      fetchedPosts.add(postId);

      // Check if the revealed slot is empty (Reddit didn't send the content)
      const revealed = sbc.querySelector('[slot="revealed"]');
      const hasContent = revealed && revealed.innerText.trim().length > 0;
      if (hasContent) return;

      // Fetch the post body via Reddit's JSON API (works in incognito)
      fetch(permalink + ".json", { credentials: "same-origin" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data) return;
          const postData = data?.[0]?.data?.children?.[0]?.data;
          const html = postData?.selftext_html;
          if (!html) return;

          // Decode HTML entities (Reddit returns &lt; &gt; etc.)
          const decoded = html
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"');

          // Replace the blurred container with the actual content
          const content = document.createElement("div");
          content.className = "nsfw-gate-injected-body";
          content.style.cssText =
            "padding: 0; font-size: 14px; line-height: 1.5; color: var(--color-neutral-content, #d7dadc);";
          content.innerHTML = decoded;

          // Make links open properly
          content.querySelectorAll("a").forEach((a) => {
            a.style.color = "var(--color-secondary-plain, #4fbcff)";
            a.style.textDecoration = "underline";
          });

          sbc.replaceWith(content);
        })
        .catch(() => {}); // silently fail
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
      // Kill the NSFW QR code "browse anonymously" dialog
      "faceplate-dialog#nsfw-qr-dialog { display: none !important; }",
      // Style for injected NSFW post body content
      ".nsfw-gate-injected-body { padding: 4px 0; }",
      ".nsfw-gate-injected-body p { margin: 0.5em 0; }",
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

    // Strategy A: Find the age-gate modal specifically.
    // Only match "Mature Content" text that appears alongside gate-specific
    // language ("confirm your age", "not for everyone") — NOT the small
    // "Mature Content" badge/tag that Reddit puts on individual posts.
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
      // Only target if this is part of the actual age gate dialog,
      // not a post badge. The gate dialog contains "not for everyone"
      // or "confirm your age" nearby.
      let container = null;
      for (let i = 0; i < 6 && el && el !== document.body; i++, el = el.parentElement) {
        const inner = (el.innerText || "").toLowerCase();
        if (inner.includes("not for everyone") || inner.includes("confirm your age")) {
          container = el;
          break;
        }
      }
      if (!container) continue;

      // Now walk up from the confirmed gate container to find the modal wrapper
      el = container;
      let candidate = null;
      while (el && el !== document.body && el !== document.documentElement) {
        if (
          el.getAttribute("role") === "dialog" ||
          el.tagName.toLowerCase().includes("overlay") ||
          el.tagName.toLowerCase().includes("modal") ||
          el.tagName.toLowerCase().includes("interstitial")
        ) {
          candidate = el;
          break; // Take the NEAREST modal wrapper, not outermost
        }
        // Fixed-position full-screen element = likely the gate overlay
        const style = getComputedStyle(el);
        if (style.position === "fixed" && el.offsetWidth > window.innerWidth * 0.5) {
          candidate = el;
          break;
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

    // Strategy D: Kill xpromo elements by tag prefix.
    document.querySelectorAll("*").forEach((el) => {
      const tag = el.tagName?.toLowerCase() || "";
      if (tag.startsWith("xpromo")) {
        el.remove();
        killed = true;
      }
    });

    // Strategy E: Kill the "Want to browse anonymously?" QR code popup.
    // This is a plain div in the sidebar, not an xpromo element — find by text.
    const qrWalker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (n) =>
          n.textContent.includes("browse anonymously")
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT,
      }
    );
    let qrNode;
    while ((qrNode = qrWalker.nextNode())) {
      // Walk up a few levels to find the card container
      let el = qrNode.parentElement;
      for (let i = 0; i < 8 && el && el !== document.body; i++) {
        // Look for the nearest container that looks like a card/widget
        const tag = el.tagName?.toLowerCase() || "";
        if (
          tag === "aside" ||
          tag === "section" ||
          el.querySelector("img[src*='qr'], canvas, svg[class*='qr']") ||
          (el.offsetWidth > 100 && el.offsetWidth < 500 && el.offsetHeight > 150)
        ) {
          el.remove();
          killed = true;
          break;
        }
        el = el.parentElement;
      }
    }

    if (killed) {
      removeBlur();
      restoreScroll();
    }

    // Always try to remove blur — Reddit may apply it without a removable modal
    // (e.g. CSS-only gate on the content)
    removeBlur();
    restoreScroll();
    injectAntiGateCSS();
    revealNsfwContent();

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
