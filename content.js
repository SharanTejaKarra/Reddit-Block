(function () {
  "use strict";

  const BLOCK_ICON_SVG =
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<line x1="4.93" y1="4.93" x2="19.07" y2="19.07" stroke="currentColor" stroke-width="2"/>' +
    "</svg>";

  let blockedUsers = new Set();
  let blockedSubreddits = new Set();

  // Subreddits that are aggregation views, not real communities
  const META_SUBREDDITS = new Set(["all", "popular", "home", "mod", "friends"]);

  // --- Logged-in user (skip self-block) ---
  let loggedInUser = null;

  function detectLoggedInUser() {
    // Ask background worker which has access to the oauth token and /api/v1/me
    chrome.runtime.sendMessage({ type: "GET_MY_USERNAME" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.username) {
        loggedInUser = response.username;
      }
    });
  }

  // --- Account Age Cache ---
  // In-memory cache: username → { ageDays, ageLabel, ageClass, fetchedAt }
  const ageCache = new Map();
  const AGE_CACHE_TTL = 1000 * 60 * 60; // 1 hour
  // Track in-flight fetches to avoid duplicate requests
  const ageFetchQueue = new Map(); // username → Promise
  // Concurrency limiter - max 5 simultaneous API calls
  let activeFetches = 0;
  const MAX_CONCURRENT_FETCHES = 5;
  const pendingFetches = []; // queue of () => Promise

  // --- Storage ---

  function loadBlocklists() {
    return new Promise((resolve) => {
      // Load from both sync and local, merge results (handles quota overflow)
      chrome.storage.sync.get(
        { blockedUsers: [], blockedSubreddits: [], blocklist: [], v2Migrated: false },
        (syncData) => {
          chrome.storage.local.get(
            { blockedUsers: [], blockedSubreddits: [] },
            (localData) => {
              // Defensive fallback migration -- only if background.js hasn't done it yet.
              if (!syncData.v2Migrated && syncData.blocklist.length > 0 && syncData.blockedUsers.length === 0) {
                const migrated = syncData.blocklist;
                blockedUsers = new Set(migrated);
                blockedSubreddits = new Set(syncData.blockedSubreddits);
                chrome.storage.sync.set(
                  { blockedUsers: migrated, blocklist: [], v2Migrated: true },
                  resolve
                );
                return;
              }

              // Merge sync + local (local may have overflow entries)
              const allUsers = [...syncData.blockedUsers, ...localData.blockedUsers];
              const allSubs = [...syncData.blockedSubreddits, ...localData.blockedSubreddits];
              blockedUsers = new Set(allUsers);
              blockedSubreddits = new Set(allSubs);
              resolve();
            }
          );
        }
      );
    });
  }

  // Try sync storage first, fall back to local if quota exceeded
  function saveToStorage(data) {
    try {
      chrome.storage.sync.set(data, () => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "";
          if (msg.includes("QUOTA") || msg.includes("quota")) {
            // Sync quota hit - fall back to local storage (5MB limit)
            chrome.storage.local.set(data);
          }
        }
      });
    } catch (e) {
      // "Extension context invalidated" after reload - try local
      try { chrome.storage.local.set(data); } catch (_) {}
    }
  }

  function saveBlockedUsers() {
    saveToStorage({ blockedUsers: [...blockedUsers] });
  }

  function saveBlockedSubreddits() {
    saveToStorage({ blockedSubreddits: [...blockedSubreddits] });
  }

  // --- Account Age ---

  function formatAge(days) {
    if (days < 1) return "<1d";
    if (days < 30) return days + "d";
    if (days < 365) return Math.floor(days / 30) + "mo";
    const years = Math.floor(days / 365);
    const remainingMonths = Math.floor((days % 365) / 30);
    if (remainingMonths > 0) return years + "y " + remainingMonths + "mo";
    return years + "y";
  }

  function formatKarma(karma) {
    if (karma < 1000) return String(karma);
    if (karma < 100000) return (karma / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    if (karma < 1000000) return Math.floor(karma / 1000) + "k";
    return (karma / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }

  function getAgeClass(days) {
    if (days < 30) return "reddit-block-age--new";
    if (days < 180) return "reddit-block-age--young";
    return "reddit-block-age--mature";
  }

  async function fetchAccountAge(username) {
    // Check in-memory cache first
    const cached = ageCache.get(username);
    if (cached && Date.now() - cached.fetchedAt < AGE_CACHE_TTL) {
      return cached;
    }

    // Deduplicate concurrent requests for the same user
    if (ageFetchQueue.has(username)) {
      return ageFetchQueue.get(username);
    }

    const promise = new Promise((resolve) => {
      const doFetch = async () => {
        activeFetches++;
        try {
          const res = await fetch("/user/" + encodeURIComponent(username) + "/about.json", {
            credentials: "same-origin",
          });
          if (!res.ok) { resolve(null); return; }
          const data = await res.json();
          const createdUtc = data?.data?.created_utc;
          if (!createdUtc) { resolve(null); return; }

          const ageDays = Math.floor((Date.now() / 1000 - createdUtc) / 86400);
          const totalKarma = (data.data.link_karma || 0) + (data.data.comment_karma || 0);
          const result = {
            ageDays,
            ageLabel: formatAge(ageDays),
            ageClass: getAgeClass(ageDays),
            karma: totalKarma,
            karmaLabel: formatKarma(totalKarma),
            fetchedAt: Date.now(),
          };
          ageCache.set(username, result);
          resolve(result);
        } catch {
          resolve(null);
        } finally {
          activeFetches--;
          ageFetchQueue.delete(username);
          // Drain the queue
          if (pendingFetches.length > 0 && activeFetches < MAX_CONCURRENT_FETCHES) {
            const next = pendingFetches.shift();
            next();
          }
        }
      };

      if (activeFetches < MAX_CONCURRENT_FETCHES) {
        doFetch();
      } else {
        pendingFetches.push(doFetch);
      }
    });

    ageFetchQueue.set(username, promise);
    return promise;
  }

  function createAgeBadge(ageData) {
    const badge = document.createElement("span");
    badge.className = "reddit-block-age " + ageData.ageClass;
    badge.textContent = ageData.ageLabel + " · " + ageData.karmaLabel;
    badge.title = "Account age: " + ageData.ageLabel + " | Karma: " + ageData.karma.toLocaleString();
    return badge;
  }

  function injectAgeBadge(anchorElement, username) {
    // Don't duplicate - check if badge already exists nearby
    const next = anchorElement.nextElementSibling;
    if (next?.classList?.contains("reddit-block-age")) return;

    fetchAccountAge(username).then((ageData) => {
      if (!ageData) return;
      // Re-check after async
      const nextNow = anchorElement.nextElementSibling;
      if (nextNow?.classList?.contains("reddit-block-age")) return;

      const badge = createAgeBadge(ageData);
      // Insert right after the link, before the block button if it exists
      anchorElement.after(badge);
    });
  }

  // --- Home feed muting (GraphQL) ---

  function getCsrfToken() {
    const match = document.cookie.match(/csrf_token=([^;]+)/);
    return match ? match[1] : null;
  }

  async function getSubredditFullname(subredditName) {
    const res = await fetch("/r/" + encodeURIComponent(subredditName) + "/about.json", {
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.name || null; // e.g. "t5_2qh1i"
  }

  async function muteSubredditHomeFeed(subredditFullname) {
    const csrf = getCsrfToken();
    if (!csrf) return false;

    const res = await fetch("/svc/shreddit/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        operation: "UpdateRecommendationPreferences",
        variables: {
          input: {
            dislikedSubredditPreference: {
              action: "ADD",
              subredditId: subredditFullname,
            },
          },
        },
        csrf_token: csrf,
      }),
    });
    return res.ok;
  }

  // --- Block button creation ---

  function createUserBlockButton(username) {
    const btn = document.createElement("button");
    btn.className = "reddit-block-btn reddit-block-user-btn";
    btn.title = "Block u/" + username;
    btn.innerHTML = BLOCK_ICON_SVG;
    btn.dataset.redditBlockUsername = username;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      blockUser(username);
    });

    return btn;
  }

  function createSubBlockButton(subreddit, subredditId) {
    const btn = document.createElement("button");
    btn.className = "reddit-block-btn reddit-block-sub-btn";
    btn.title = "Block r/" + subreddit;
    btn.innerHTML = BLOCK_ICON_SVG;
    btn.dataset.redditBlockSubreddit = subreddit;
    if (subredditId) btn.dataset.redditBlockSubredditId = subredditId;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      blockSubreddit(subreddit, subredditId);
    });

    return btn;
  }

  // --- Container-level block button injection ---
  // Feed/detail posts: 1 subreddit button + 1 user button (only if username is visible).
  // Comments: 1 user block button per comment.

  function findVisibleAuthorLink(container, author) {
    // Find the first author link whose visible text shows the username.
    // Skip avatar links, icon links, and links in nested child containers.
    const allLinks = container.querySelectorAll(
      'a[href*="/user/' + CSS.escape(author) + '"]'
    );
    for (const link of allLinks) {
      // For posts, skip links inside nested comments (detail view)
      const parentPost = link.closest("shreddit-comment");
      if (parentPost) continue;

      const text = link.textContent.trim();
      if (text.includes(author) || text.includes("u/" + author)) {
        return link;
      }
    }
    return null;
  }

  function processPost(post) {
    if (post.dataset.redditBlockProcessed) return;
    post.dataset.redditBlockProcessed = "1";

    // Extract subreddit name (lowercase, skip meta-subs)
    const subAttr =
      post.getAttribute("subreddit-prefixed-name") ||
      post.getAttribute("subreddit");
    const subName = subAttr ? subAttr.replace(/^r\//, "").toLowerCase() : null;
    const validSub = subName && !META_SUBREDDITS.has(subName);

    // Find the primary subreddit link in the post header
    const subLink =
      post.querySelector('a[href*="/r/"][data-post-click-location="subreddit-link"]') ||
      post.querySelector('a[href*="/r/"].subreddit') ||
      post.querySelector('a[href*="/r/"]');

    // Read the subreddit fullname (t5_xxxxx) directly from the post element
    const subId = post.getAttribute("subreddit-id") || null;

    // Inject ONE subreddit block button next to the subreddit link
    if (validSub && subLink && !subLink.nextElementSibling?.classList?.contains("reddit-block-btn")) {
      const subBtn = createSubBlockButton(subName, subId);
      subLink.after(subBtn);
    }

    // Inject ONE user block button -- only if the username is visually displayed
    const author = post.getAttribute("author");
    if (author) {
      const authorLink = findVisibleAuthorLink(post, author);
      if (authorLink) {
        injectAgeBadge(authorLink, author);
        // Skip block button for the logged-in user (no self-blocking)
        const isSelf = loggedInUser && author.toLowerCase() === loggedInUser.toLowerCase();
        if (!isSelf && !post.querySelector('.reddit-block-user-btn[data-reddit-block-username="' + CSS.escape(author) + '"]')) {
          const userBtn = createUserBlockButton(author);
          authorLink.after(userBtn);
        }
      }
    }
  }

  function processComment(comment) {
    if (comment.dataset.redditBlockProcessed) return;
    comment.dataset.redditBlockProcessed = "1";

    const author = comment.getAttribute("author");
    if (!author) return;

    // Find username links matching this comment's author.
    // IMPORTANT: shreddit-comments are nested, so querySelectorAll would find
    // links in child comments too. We need to only match DIRECT links of THIS
    // comment, not descendant shreddit-comment links.
    const allLinks = comment.querySelectorAll(
      'a[href*="/user/' + CSS.escape(author) + '"]'
    );

    let targetLink = null;
    for (const link of allLinks) {
      // Skip links that belong to a nested child comment
      const parentComment = link.closest("shreddit-comment");
      if (parentComment !== comment) continue;

      // Prefer the link whose visible text contains the author name
      const text = link.textContent.trim();
      if (text.includes(author) || text.includes("u/" + author)) {
        targetLink = link;
        break;
      }
    }

    // Fallback: if no text-based match, use the first direct link
    if (!targetLink) {
      for (const link of allLinks) {
        const parentComment = link.closest("shreddit-comment");
        if (parentComment !== comment) continue;
        targetLink = link;
        break;
      }
    }

    // Inject age badge + block button
    if (targetLink) {
      injectAgeBadge(targetLink, author);
      // Skip block button for the logged-in user (no self-blocking)
      const isSelf = loggedInUser && author.toLowerCase() === loggedInUser.toLowerCase();
      if (!isSelf && !comment.querySelector('.reddit-block-user-btn[data-reddit-block-username="' + CSS.escape(author) + '"]')) {
        const btn = createUserBlockButton(author);
        targetLink.after(btn);
      }
    }
  }

  function injectBlockButtons() {
    // Process all shreddit-post elements (feed view, detail view, overlays)
    document.querySelectorAll("shreddit-post").forEach(processPost);

    // Process comments: at most 1 user button per comment
    document.querySelectorAll("shreddit-comment").forEach(processComment);
  }

  // --- Blocking logic ---

  function blockUser(username) {
    // Hide immediately -- no awaiting storage before DOM update
    blockedUsers.add(username);
    hideBlockedContent();
    saveBlockedUsers();

    // Call Reddit's block API via background worker
    chrome.runtime.sendMessage(
      { type: "BLOCK_USER", username },
      (response) => {
        if (chrome.runtime.lastError) {
          showBlockedToast("u/" + username + " hidden");
          return;
        }
        if (response && response.success) {
          showBlockedToast("u/" + username + " blocked");
        } else if (response && response.error === "NOT_LOGGED_IN") {
          showBlockedToast("u/" + username + " hidden (sign in to fully block)");
        } else {
          showBlockedToast("u/" + username + " hidden");
        }
      }
    );
  }

  function blockSubreddit(subreddit, subredditId) {
    const normalized = subreddit.toLowerCase();
    // Hide immediately -- no awaiting storage before DOM update
    blockedSubreddits.add(normalized);
    hideBlockedContent();
    saveBlockedSubreddits();

    // Fire both API calls in parallel, show toast based on combined result
    // Use the t5_ ID from the post element if available, otherwise look it up
    const graphqlPromise = (subredditId
      ? Promise.resolve(subredditId)
      : getSubredditFullname(normalized)
    )
      .then((fullname) => (fullname ? muteSubredditHomeFeed(fullname) : false))
      .catch(() => false);

    const filterPromise = new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "FILTER_SUBREDDIT", subreddit: normalized },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: "RUNTIME_ERROR" });
            return;
          }
          resolve(response || { success: false });
        }
      );
    });

    Promise.all([graphqlPromise, filterPromise]).then(([graphqlOk, filterResponse]) => {
      if (graphqlOk || filterResponse.success) {
        showBlockedToast("r/" + subreddit + " blocked from feed");
      } else if (filterResponse.error === "NOT_LOGGED_IN") {
        showBlockedToast("r/" + subreddit + " hidden from feed");
      } else {
        showBlockedToast("r/" + subreddit + " hidden from feed");
      }
    });
  }

  function showBlockedToast(message) {
    let toast = document.getElementById("reddit-block-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "reddit-block-toast";
      toast.className = "reddit-block-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2000);
  }

  // --- Soft-block comment hiding (nested comment fix) ---
  //
  // Problem: <shreddit-comment> nests child comments as light DOM children
  // rendered via <slot>. Any CSS on the HOST element (display:none, opacity,
  // overflow:hidden) propagates to slotted children, hiding replies from
  // innocent users.
  //
  // Solution: Inject CSS into the comment's open shadow root to hide only
  // its OWN rendered UI while keeping the default <slot> (child comments)
  // and #comment-children (thread lines) visible.
  //
  // Shadow DOM structure of <shreddit-comment> (from DevTools):
  //   #shadow-root (open)
  //     <details role="article" open>
  //       <summary>
  //         <slot name="commentAvatar">    -- avatar
  //         <slot name="commentMeta">      -- username, timestamp
  //       </summary>
  //       <div class="grid ...">
  //         <slot></slot>                  -- DEFAULT SLOT = child comments
  //         <slot name="comment-edit">
  //         <slot name="comment">          -- comment body text
  //         <slot name="actionRow">        -- vote/reply/share
  //         <slot name="awardsRow">
  //         <slot name="next-reply">
  //         <div id="comment-children">    -- thread lines
  //       </div>
  //     </details>

  // CSS injected into blocked comment shadow roots.
  // :host(.reddit-block-comment-hidden) gates all rules so they only
  // activate when the class is present on the host element.
  // Targets specific named slots and summary to hide the comment's own
  // content while keeping the default <slot> (child comments) visible.
  const BLOCKED_SHADOW_CSS = [
    ":host(.reddit-block-comment-hidden) summary { display: none !important; }",
    ':host(.reddit-block-comment-hidden) slot[name="comment"] { display: none !important; }',
    ':host(.reddit-block-comment-hidden) slot[name="comment-edit"] { display: none !important; }',
    ':host(.reddit-block-comment-hidden) slot[name="actionRow"] { display: none !important; }',
    ':host(.reddit-block-comment-hidden) slot[name="awardsRow"] { display: none !important; }',
    ':host(.reddit-block-comment-hidden) slot[name="next-reply"] { display: none !important; }',
    ':host(.reddit-block-comment-hidden) slot[name="commentAvatar"] { display: none !important; }',
    ':host(.reddit-block-comment-hidden) slot[name="commentMeta"] { display: none !important; }',
    ":host(.reddit-block-comment-hidden) .reddit-block-placeholder { display: block !important; }",
  ].join("\n");

  // Shared CSSStyleSheet instance (created once, shared across all shadow roots)
  let blockedCommentSheet = null;

  function getBlockedCommentSheet() {
    if (!blockedCommentSheet) {
      blockedCommentSheet = new CSSStyleSheet();
      blockedCommentSheet.replaceSync(BLOCKED_SHADOW_CSS);
    }
    return blockedCommentSheet;
  }

  function softBlockComment(comment) {
    if (comment.classList.contains("reddit-block-comment-hidden")) return;

    const shadow = comment.shadowRoot;
    if (!shadow) {
      // No shadow root - Reddit hasn't rendered this component yet, or
      // the structure changed. Fall back to display:none on the host.
      comment.style.display = "none";
      comment.dataset.redditBlockFallbackHidden = "1";
      return;
    }

    // Inject our stylesheet into the shadow root via adoptedStyleSheets.
    // Non-destructive - appends alongside Reddit's own sheets.
    const sheet = getBlockedCommentSheet();
    if (!shadow.adoptedStyleSheets.includes(sheet)) {
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
    }

    // Insert a placeholder inside the <details> element (after the hidden
    // <summary>) so it sits in the article layout context. Inline styles
    // are necessary because page-level CSS can't pierce shadow boundaries.
    if (!shadow.querySelector(".reddit-block-placeholder")) {
      const placeholder = document.createElement("div");
      placeholder.className = "reddit-block-placeholder";
      const author = comment.getAttribute("author") || "user";
      placeholder.textContent = "[Blocked user \u2013 u/" + author + "]";
      placeholder.style.cssText =
        "padding:6px 8px;font-size:12px;color:#878a8c;font-style:italic;" +
        "border-left:2px solid #edeff1;margin:4px 0;opacity:0.7;" +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
        "user-select:none;cursor:default;";
      const details = shadow.querySelector("details");
      if (details) {
        // Insert after <summary> so it appears where the comment body would be
        const summary = details.querySelector("summary");
        if (summary) {
          summary.after(placeholder);
        } else {
          details.insertBefore(placeholder, details.firstChild);
        }
      } else {
        shadow.insertBefore(placeholder, shadow.firstChild);
      }
    }

    // Adding this class activates the :host() rules inside the shadow root.
    // The CSS targets specific named slots (comment, actionRow, etc.) and
    // summary to hide the comment's own UI while keeping the default <slot>
    // (child comments) and #comment-children (thread lines) visible.
    comment.classList.add("reddit-block-comment-hidden");
  }

  function unsoftBlockComment(comment) {
    // Check fallback path first
    if (comment.dataset.redditBlockFallbackHidden) {
      comment.style.display = "";
      delete comment.dataset.redditBlockFallbackHidden;
      return;
    }

    comment.classList.remove("reddit-block-comment-hidden");

    const shadow = comment.shadowRoot;
    if (!shadow) return;

    // Remove placeholder from shadow root
    const placeholder = shadow.querySelector(".reddit-block-placeholder");
    if (placeholder) placeholder.remove();

    // Leave the adoptedStyleSheet in place - its rules are gated behind
    // :host(.reddit-block-comment-hidden) so they're inert without the class.
  }

  // Process a single post element for blocking
  function processPostBlocking(post) {
    const author = post.getAttribute("author");
    const subreddit =
      post.getAttribute("subreddit-prefixed-name") ||
      post.getAttribute("subreddit");
    const subName = subreddit ? subreddit.replace(/^r\//, "").toLowerCase() : null;

    const blockedByUser = author && blockedUsers.has(author);
    const blockedBySub = subName && blockedSubreddits.has(subName);

    if (blockedByUser || blockedBySub) {
      post.classList.add("reddit-block-hidden");
    } else {
      post.classList.remove("reddit-block-hidden");
    }
  }

  // Process a single comment element for blocking
  function processCommentBlocking(comment) {
    const author = comment.getAttribute("author");
    if (author && blockedUsers.has(author)) {
      softBlockComment(comment);
    }
  }

  function hideBlockedContent() {
    if (blockedUsers.size === 0 && blockedSubreddits.size === 0) return;

    document.querySelectorAll("shreddit-post").forEach(processPostBlocking);
    document.querySelectorAll("shreddit-comment").forEach(processCommentBlocking);

    // Fallback: hide old-Reddit / non-shreddit post/comment containers.
    document.querySelectorAll('a[href*="/user/"]').forEach((link) => {
      const hrefMatch = link
        .getAttribute("href")
        ?.match(/\/user\/([A-Za-z0-9_-]+)/);
      if (!hrefMatch) return;

      const username = hrefMatch[1];

      // Skip shreddit elements -- they're already processed above
      if (link.closest("shreddit-post") || link.closest("shreddit-comment")) return;

      const container =
        link.closest('[data-testid="post-container"]') ||
        link.closest('[data-testid="comment"]') ||
        link.closest(".comment") ||
        link.closest("article");

      if (container) {
        if (blockedUsers.has(username)) {
          container.classList.add("reddit-block-hidden");
        } else {
          container.classList.remove("reddit-block-hidden");
        }
      }
    });
  }

  // Process only newly added DOM nodes instead of re-scanning the entire page.
  // Falls back to full scan if the mutations are too broad (e.g. SPA navigation).
  function processNewNodes(mutations) {
    let newPosts = [];
    let newComments = [];

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Check if the added node itself is a post/comment
        if (node.nodeName === "SHREDDIT-POST") {
          newPosts.push(node);
        } else if (node.nodeName === "SHREDDIT-COMMENT") {
          newComments.push(node);
        }

        // Also check children of the added node
        if (node.querySelectorAll) {
          const posts = node.querySelectorAll("shreddit-post");
          const comments = node.querySelectorAll("shreddit-comment");
          for (const p of posts) newPosts.push(p);
          for (const c of comments) newComments.push(c);
        }
      }
    }

    // If we found specific new nodes, process only those
    if (newPosts.length > 0 || newComments.length > 0) {
      newPosts.forEach((p) => {
        processPost(p);
        processPostBlocking(p);
      });
      newComments.forEach((c) => {
        processComment(c);
        processCommentBlocking(c);
      });
      return true;
    }

    return false; // no specific nodes found, caller should do full scan
  }

  function unhideAll() {
    document.querySelectorAll(".reddit-block-hidden").forEach((el) => {
      el.classList.remove("reddit-block-hidden");
    });
    // Undo soft-blocked comments
    document.querySelectorAll(".reddit-block-comment-hidden").forEach((el) => {
      unsoftBlockComment(el);
    });
    // Also catch fallback-hidden comments (no shadow root path)
    document.querySelectorAll("[data-reddit-block-fallback-hidden]").forEach((el) => {
      el.style.display = "";
      delete el.dataset.redditBlockFallbackHidden;
    });
  }

  // --- MutationObserver for SPA navigation & infinite scroll ---

  let processTimeout = null;
  let pendingMutations = [];

  function scheduleProcess(mutations) {
    if (mutations) pendingMutations.push(...mutations);
    if (processTimeout) clearTimeout(processTimeout);
    processTimeout = setTimeout(() => {
      processTimeout = null;
      const collected = pendingMutations;
      pendingMutations = [];

      // Try targeted processing of just the new nodes
      if (collected.length > 0 && collected.length < 50) {
        if (processNewNodes(collected)) return;
      }

      // Fall back to full scan (SPA navigation, bulk DOM change, etc.)
      injectBlockButtons();
      hideBlockedContent();
    }, 200);
  }

  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldProcess = false;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldProcess = true;
          break;
        }
      }

      if (shouldProcess) {
        scheduleProcess(mutations);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  // Listen for storage changes (from popup, other tabs, etc.)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.blockedUsers) {
      blockedUsers = new Set(changes.blockedUsers.newValue || []);
      unhideAll();
      hideBlockedContent();
    }
    if (changes.blockedSubreddits) {
      blockedSubreddits = new Set(changes.blockedSubreddits.newValue || []);
      unhideAll();
      hideBlockedContent();
    }
    // Legacy support: if old blocklist key changes (e.g. from another v1 tab),
    // merge into blockedUsers. The blocklist: [] write below won't re-trigger
    // this listener for blocklist because the newValue will be empty.
    if (changes.blocklist) {
      const legacy = changes.blocklist.newValue || [];
      if (legacy.length > 0) {
        legacy.forEach((u) => blockedUsers.add(u));
        try {
          chrome.storage.sync.set({
            blockedUsers: [...blockedUsers],
            blocklist: [],
            v2Migrated: true,
          });
        } catch (e) {
          // Silently ignore "Extension context invalidated" after reload
        }
        unhideAll();
        hideBlockedContent();
      }
    }
  });

  // --- Init ---

  async function init() {
    detectLoggedInUser();
    await loadBlocklists();
    injectBlockButtons();
    hideBlockedContent();
    setupObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
