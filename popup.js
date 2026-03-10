(function () {
  const searchInput = document.getElementById("search-input");
  const itemList = document.getElementById("item-list");
  const emptyState = document.getElementById("empty-state");
  const totalCount = document.getElementById("total-count");
  const usersCountEl = document.getElementById("users-count");
  const subsCountEl = document.getElementById("subs-count");
  const exportBtn = document.getElementById("export-btn");
  const importBtn = document.getElementById("import-btn");
  const importFile = document.getElementById("import-file");
  const tabs = document.querySelectorAll(".tab");

  let blockedUsers = new Set();
  let blockedSubreddits = new Set();
  let activeTab = "users"; // "users" or "subreddits"

  function loadData() {
    chrome.storage.sync.get(
      { blockedUsers: [], blockedSubreddits: [], blocklist: [], v2Migrated: false },
      (data) => {
        // Defensive fallback migration -- only if background.js hasn't done it yet.
        // background.js onInstalled is the primary migration path and sets v2Migrated.
        if (!data.v2Migrated && data.blocklist.length > 0 && data.blockedUsers.length === 0) {
          blockedUsers = new Set(data.blocklist);
          blockedSubreddits = new Set(data.blockedSubreddits);
          chrome.storage.sync.set(
            { blockedUsers: [...blockedUsers], blocklist: [], v2Migrated: true },
            () => render()
          );
          return;
        }
        blockedUsers = new Set(data.blockedUsers);
        blockedSubreddits = new Set(data.blockedSubreddits);
        render();
      }
    );
  }

  function saveBlockedUsers(callback) {
    chrome.storage.sync.set({ blockedUsers: [...blockedUsers] }, () => {
      if (callback) callback();
    });
  }

  function saveBlockedSubreddits(callback) {
    chrome.storage.sync.set({ blockedSubreddits: [...blockedSubreddits] }, () => {
      if (callback) callback();
    });
  }

  // Tab switching
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      searchInput.value = "";
      searchInput.placeholder =
        activeTab === "users"
          ? "Search blocked users..."
          : "Search blocked subreddits...";
      render();
    });
  });

  function render(filter) {
    const set = activeTab === "users" ? blockedUsers : blockedSubreddits;
    const prefix = activeTab === "users" ? "u/" : "r/";

    const items = [...set];
    const filtered = filter
      ? items.filter((item) =>
          item.toLowerCase().includes(filter.toLowerCase())
        )
      : items;

    // Update counts
    const total = blockedUsers.size + blockedSubreddits.size;
    totalCount.textContent = total + " blocked";
    usersCountEl.textContent = blockedUsers.size;
    subsCountEl.textContent = blockedSubreddits.size;

    // Clear items
    itemList.querySelectorAll(".item-entry").forEach((el) => el.remove());

    if (set.size === 0) {
      emptyState.style.display = "block";
      if (activeTab === "users") {
        emptyState.innerHTML =
          "<p>No blocked users yet.</p>" +
          '<p class="hint">Click the block button next to any Reddit username to get started.</p>';
      } else {
        emptyState.innerHTML =
          "<p>No blocked subreddits yet.</p>" +
          '<p class="hint">Click the block button next to any subreddit name in your feed.</p>';
      }
      return;
    }

    emptyState.style.display = "none";

    const sorted = [...filtered].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    sorted.forEach((name) => {
      const item = document.createElement("div");
      item.className = "item-entry";
      item.innerHTML =
        '<span class="item-name">' +
        prefix +
        escapeHtml(name) +
        "</span>" +
        '<button class="unblock-btn">Unblock</button>';

      item.querySelector(".unblock-btn").addEventListener("click", () => {
        if (activeTab === "users") {
          unblockUser(name);
        } else {
          unblockSubreddit(name);
        }
      });

      itemList.appendChild(item);
    });
  }

  function unblockUser(username) {
    // Remove from local storage immediately
    blockedUsers.delete(username);
    saveBlockedUsers(() => {
      render(searchInput.value);
      showToast("Unblocked u/" + username);
    });

    // Also call Reddit's unblock API via background worker
    chrome.runtime.sendMessage(
      { type: "UNBLOCK_USER", username },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (response && !response.success) {
          showToast("Local only -- visit reddit.com/prefs/blocked to fully unblock");
        }
      }
    );
  }

  function unblockSubreddit(subreddit) {
    // Remove from local storage immediately
    blockedSubreddits.delete(subreddit);
    saveBlockedSubreddits(() => {
      render(searchInput.value);
      showToast("Unblocked r/" + subreddit);
    });

    // Also remove the r/all filter via background worker
    chrome.runtime.sendMessage(
      { type: "UNFILTER_SUBREDDIT", subreddit },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (response && !response.success) {
          showToast("Local only -- r/all filter may remain");
        }
      }
    );
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message) {
    let toast = document.querySelector(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2000);
  }

  // Export both lists as JSON
  exportBtn.addEventListener("click", () => {
    if (blockedUsers.size === 0 && blockedSubreddits.size === 0) {
      showToast("Nothing to export");
      return;
    }
    const data = JSON.stringify(
      {
        blockedUsers: [...blockedUsers],
        blockedSubreddits: [...blockedSubreddits],
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    );
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "reddit-blocklist.json";
    a.click();
    URL.revokeObjectURL(url);
    const total = blockedUsers.size + blockedSubreddits.size;
    showToast("Exported " + total + " entries");
  });

  // Import blocklist from JSON
  importBtn.addEventListener("click", () => {
    importFile.click();
  });

  importFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        let importedUsers = [];
        let importedSubs = [];

        if (Array.isArray(data)) {
          // Plain array -- treat as users (legacy)
          importedUsers = data;
        } else if (data.blockedUsers || data.blockedSubreddits) {
          // New v2 format
          importedUsers = Array.isArray(data.blockedUsers)
            ? data.blockedUsers
            : [];
          importedSubs = Array.isArray(data.blockedSubreddits)
            ? data.blockedSubreddits
            : [];
        } else if (data.blocklist && Array.isArray(data.blocklist)) {
          // Old v1 format -- treat blocklist as users
          importedUsers = data.blocklist;
        } else {
          showToast("Invalid file format");
          return;
        }

        // Validate: all entries should be non-empty strings
        importedUsers = importedUsers.filter(
          (u) => typeof u === "string" && u.trim().length > 0
        );
        // Normalize subreddit names to lowercase for case-insensitive matching
        importedSubs = importedSubs
          .filter((s) => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.toLowerCase());

        // Merge with existing
        const prevUserCount = blockedUsers.size;
        const prevSubCount = blockedSubreddits.size;
        importedUsers.forEach((u) => blockedUsers.add(u));
        importedSubs.forEach((s) => blockedSubreddits.add(s));
        const addedUsers = blockedUsers.size - prevUserCount;
        const addedSubs = blockedSubreddits.size - prevSubCount;

        saveBlockedUsers(() => {
          saveBlockedSubreddits(() => {
            render(searchInput.value);
            const total = addedUsers + addedSubs;
            showToast(
              "Imported " + total + " new entr" + (total !== 1 ? "ies" : "y")
            );
          });
        });
      } catch (err) {
        showToast("Failed to parse file");
      }
    };
    reader.readAsText(file);
    importFile.value = "";
  });

  // Search filter
  searchInput.addEventListener("input", () => {
    render(searchInput.value);
  });

  // Listen for external changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.blockedUsers) {
      blockedUsers = new Set(changes.blockedUsers.newValue || []);
      render(searchInput.value);
    }
    if (changes.blockedSubreddits) {
      blockedSubreddits = new Set(changes.blockedSubreddits.newValue || []);
      render(searchInput.value);
    }
  });

  // Initial load
  loadData();
})();
