// Reddit Block v2 - Background Service Worker
// Handles Reddit API calls for real user/subreddit blocking.
// Content scripts send messages here; this worker makes authenticated API calls.
// The access token ONLY lives in this scope -- never injected into content scripts.

const OAUTH_BASE = "https://oauth.reddit.com";
const USER_AGENT = "Reddit_Block_Extension/2.0";

// --- Badge Count ---

function updateBadgeCount() {
  chrome.storage.sync.get({ blockedUsers: [], blockedSubreddits: [] }, (data) => {
    if (!data) return;
    const users = data.blockedUsers || [];
    const subs = data.blockedSubreddits || [];
    const total = users.length + subs.length;
    chrome.action.setBadgeText({ text: total > 0 ? String(total) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#ff4500" });
  });
}

// Update badge whenever storage changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.blockedUsers || changes.blockedSubreddits) {
    updateBadgeCount();
  }
});

// --- v1 → v2 Storage Migration ---

chrome.runtime.onInstalled.addListener(() => {
  // Primary v1 → v2 migration path. Sets v2Migrated flag so content.js and
  // popup.js don't attempt a concurrent migration write.
  chrome.storage.sync.get(
    { blocklist: [], blockedUsers: [], v2Migrated: false },
    (data) => {
      if (data.v2Migrated) return;
      if (data.blocklist.length > 0 && data.blockedUsers.length === 0) {
        chrome.storage.sync.set({
          blockedUsers: data.blocklist,
          blocklist: [],
          v2Migrated: true,
        });
      } else {
        chrome.storage.sync.set({ v2Migrated: true });
      }
    }
  );

  // Set initial badge count
  updateBadgeCount();
});

// Also set badge on service worker startup (browser restart, extension reload)
updateBadgeCount();

// --- Token Extraction ---

async function getAccessToken() {
  const cookie = await chrome.cookies.get({
    url: "https://www.reddit.com",
    name: "token_v2",
  });

  if (!cookie || !cookie.value) {
    throw new Error("NOT_LOGGED_IN");
  }

  // The token_v2 cookie value itself is the bearer token
  return cookie.value;
}

// --- Get Current User's Username ---

let cachedUsername = null;

async function getMyUsername(token) {
  if (cachedUsername) return cachedUsername;

  const resp = await fetch(OAUTH_BASE + "/api/v1/me", {
    headers: {
      Authorization: "Bearer " + token,
      "User-Agent": USER_AGENT,
    },
  });

  if (!resp.ok) {
    throw new Error("FETCH_ME_FAILED");
  }

  const data = await resp.json();
  cachedUsername = data.name;
  return cachedUsername;
}

// --- API Calls ---

async function blockUserAPI(username) {
  const token = await getAccessToken();

  const resp = await fetch(OAUTH_BASE + "/api/block_user/", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: "name=" + encodeURIComponent(username),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("API_ERROR: " + resp.status + " " + text);
  }

  return await resp.json();
}

async function filterSubredditAPI(subreddit) {
  // Uses the r/all filter endpoint -- the only publicly documented way
  // to filter subreddits via the API. Filters from r/all and r/popular.
  // Home feed filtering uses CSS hiding as fallback (undocumented API).
  const token = await getAccessToken();
  const myName = await getMyUsername(token);

  const url =
    OAUTH_BASE +
    "/api/filter/user/" +
    encodeURIComponent(myName) +
    "/f/all/r/" +
    encodeURIComponent(subreddit);

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "User-Agent": USER_AGENT,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("API_ERROR: " + resp.status + " " + text);
  }

  return { success: true };
}

// --- Unblock API Calls ---

async function unblockUserAPI(username) {
  const token = await getAccessToken();

  const resp = await fetch(OAUTH_BASE + "/api/unfriend/", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body:
      "name=" + encodeURIComponent(username) +
      "&type=enemy",
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("API_ERROR: " + resp.status + " " + text);
  }

  return { success: true };
}

async function unfilterSubredditAPI(subreddit) {
  const token = await getAccessToken();
  const myName = await getMyUsername(token);

  const url =
    OAUTH_BASE +
    "/api/filter/user/" +
    encodeURIComponent(myName) +
    "/f/all/r/" +
    encodeURIComponent(subreddit);

  const resp = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: "Bearer " + token,
      "User-Agent": USER_AGENT,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("API_ERROR: " + resp.status + " " + text);
  }

  return { success: true };
}

// --- Message Handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "BLOCK_USER") {
    blockUserAPI(message.username)
      .then((result) => {
        sendResponse({ success: true, data: result });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    // Return true to keep the message channel open for async response
    return true;
  }

  if (message.type === "FILTER_SUBREDDIT") {
    filterSubredditAPI(message.subreddit)
      .then((result) => {
        sendResponse({ success: true, data: result });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === "UNBLOCK_USER") {
    unblockUserAPI(message.username)
      .then((result) => {
        sendResponse({ success: true, data: result });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (message.type === "GET_MY_USERNAME") {
    getAccessToken()
      .then((token) => getMyUsername(token))
      .then((username) => {
        sendResponse({ username });
      })
      .catch(() => {
        sendResponse({ username: null });
      });
    return true;
  }

  if (message.type === "UNFILTER_SUBREDDIT") {
    unfilterSubredditAPI(message.subreddit)
      .then((result) => {
        sendResponse({ success: true, data: result });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});
