/**
 * CareerVine Content Script
 * Handles LinkedIn profile scraping and slide-out panel UI
 */

// State
let isPanelOpen = false;
let isAnalyzing = false;
let lastAnalyzedProfileId = null;
let lastScrapeTimestamp = 0;
let lastDbCheck = null; // { profileId, contact|null } — cached so results can be re-emitted
let autoScrapeEnabled = false;
const SCRAPE_COOLDOWN_MS = 30000;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Load and cache auto-scrape setting
chrome.storage.local.get(['autoScrapeEnabled'], (result) => {
  autoScrapeEnabled = result.autoScrapeEnabled || false;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoScrapeEnabled) {
    autoScrapeEnabled = changes.autoScrapeEnabled.newValue || false;
  }
});

// Private event bus
const _bus = new EventTarget();

function emit(name, detail = {}) {
  _bus.dispatchEvent(new CustomEvent(name, { detail }));
}

window.__cv_bus = _bus;

let _shadowRoot = null;

// ---- Panel creation ----

function createPanel() {
  if (document.getElementById('_cv-ph')) return;

  const host = document.createElement('div');
  host.id = '_cv-ph';
  host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647; height: 100vh; pointer-events: none;';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });
  _shadowRoot = shadow;

  const panel = document.createElement('div');
  panel.id = '_cv-p';
  panel.className = 'careervine-panel';
  panel.style.cssText = 'pointer-events: auto;';
  panel.innerHTML = `<div id="root"></div>`;
  shadow.appendChild(panel);

  setTimeout(() => {
    panel.classList.add('open');
    isPanelOpen = true;
  }, 100);

  loadPanelScript(shadow);
}

function loadPanelScript(shadowRoot) {
  window.process = { env: { NODE_ENV: 'production' } };
  window.__cv_sr = shadowRoot;
  import(chrome.runtime.getURL('src/content/panel-app/panel.js')).catch(() => {});
}

function createFAB() {
  if (document.getElementById('_cv-f')) return;

  const fab = document.createElement('button');
  fab.id = '_cv-f';
  fab.className = '_cv-f';
  // Only useful on profile pages — hidden elsewhere (feed, jobs, search)
  if (!extractProfileId(window.location.href)) fab.style.display = 'none';
  fab.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 20h10"/>
      <path d="M10 20c5.5-2.5.8-6.4 3-10"/>
      <path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/>
      <path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>
    </svg>
  `;
  fab.title = 'Import to CareerVine';
  fab.addEventListener('click', togglePanel);
  document.body.appendChild(fab);
}

function togglePanel() {
  isPanelOpen ? closePanel() : openPanel();
}

// ---- Profile cache ----

async function getCachedProfile(profileId) {
  const { profileCache = {} } = await chrome.storage.local.get(['profileCache']);
  const entry = profileCache[profileId];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) return entry.data;
  return null;
}

async function setCachedProfile(profileId, data, photoUrl) {
  const { profileCache = {} } = await chrome.storage.local.get(['profileCache']);
  const now = Date.now();
  const cleaned = {};
  for (const [key, val] of Object.entries(profileCache)) {
    if (now - val.timestamp < CACHE_TTL_MS) cleaned[key] = val;
  }
  cleaned[profileId] = { data, photoUrl: photoUrl || null, timestamp: now };
  await chrome.storage.local.set({ profileCache: cleaned });
}

async function tryLoadFromCache(profileId) {
  const { profileCache = {} } = await chrome.storage.local.get(['profileCache']);
  const entry = profileCache[profileId];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    lastAnalyzedProfileId = profileId;
    emit('cachedhit', { profileData: entry.data, photoUrl: entry.photoUrl || null });
    return true;
  }
  return false;
}

// ---- DB lookup (no scraping, no page interaction) ----

function emitDbResult({ profileId, contact }) {
  if (contact) {
    emit('dbmatch', { contact, profileId });
  } else {
    emit('dbnomatch', { profileId });
  }
}

async function checkProfileInDB(profileId) {
  if (!isExtensionContextValid()) return;

  // Re-emit the cached result instead of refetching — the panel may have
  // missed the first emission (e.g. it hadn't mounted yet on first open).
  if (lastDbCheck && lastDbCheck.profileId === profileId) {
    emitDbResult(lastDbCheck);
    return;
  }

  try {
    const linkedinUrl = `https://www.linkedin.com/in/${profileId}/`;
    const response = await chrome.runtime.sendMessage({
      action: 'checkDuplicate',
      data: { linkedinUrl }
    });

    if (response?.error) {
      // Check failed (e.g. not signed in) — report no-match but don't cache,
      // so a later sync (post-login) refetches instead of replaying this.
      emit('dbnomatch', { profileId });
      return;
    }

    const contact = response?.duplicates?.length > 0 ? response.duplicates[0] : null;
    lastDbCheck = { profileId, contact };
    emitDbResult(lastDbCheck);
  } catch {
    emit('dbnomatch', { profileId });
  }
}

// ---- Progress + scraping ----

function dispatchProgress(stage, percent) {
  emit('progress', { stage, percent });
}

function analyzeCurrentProfile(profileId, calledFromNav = false) {
  isAnalyzing = true;
  emit('analyzing', { analyzing: true });
  dispatchProgress('starting', 0);

  const doScrape = () => {
    scrapeCurrentProfile().then(async (result) => {
      isAnalyzing = false;
      if (result?.scraped) {
        lastAnalyzedProfileId = profileId;
        await setCachedProfile(profileId, result.profileData, result.photoUrl);
        emit('profiledata', { profileData: result.profileData, photoUrl: result.photoUrl || null });
      }
      if (result?.parseError) {
        // Parsing failed server-side (e.g. no usable OpenAI key, CAR-26).
        // Tell the panel WHY so it can render a specific state, not "done".
        emit('parseerror', result.parseError);
        dispatchProgress('error', 0);
      } else {
        dispatchProgress('done', 100);
      }
      emit('analyzing', { analyzing: false });
    }).catch(() => {
      isAnalyzing = false;
      dispatchProgress('error', 0);
      emit('analyzing', { analyzing: false });
    });
  };

  if (calledFromNav) {
    setTimeout(doScrape, 2000);
  } else {
    doScrape();
  }
}

// Push the current page's state to the panel: DB check, cache, auto-scrape.
// Runs when the panel signals it has mounted ('panel-ready') and on every
// re-open of an already-mounted panel.
function syncPanelState() {
  const currentProfileId = extractProfileId(window.location.href);
  if (!currentProfileId) {
    emit('leftprofile');
    return;
  }

  // Check DB first (fast, no page interaction)
  checkProfileInDB(currentProfileId);

  if (currentProfileId !== lastAnalyzedProfileId) {
    // Try cache — if hit, profile loads instantly
    tryLoadFromCache(currentProfileId).then((hit) => {
      if (!hit) {
        if (autoScrapeEnabled) {
          analyzeCurrentProfile(currentProfileId);
        } else {
          // Nothing to show — tell the panel it's a fresh profile so it
          // leaves its loading state and offers manual analysis.
          emit('newprofile', { profileId: currentProfileId });
        }
      }
    }).catch(() => {});
  }
}

function openPanel() {
  const firstOpen = !_shadowRoot;
  createPanel();
  if (_shadowRoot) {
    const panel = _shadowRoot.getElementById('_cv-p');
    if (panel) {
      panel.classList.add('open');
      isPanelOpen = true;

      // On first open the React app hasn't mounted yet — it announces
      // 'panel-ready' when its listeners are attached, and syncPanelState
      // runs then. Only sync directly on re-open of a mounted panel.
      if (!firstOpen) {
        syncPanelState();
      }
    }
  }
}

function closePanel() {
  if (_shadowRoot) {
    const panel = _shadowRoot.getElementById('_cv-p');
    if (panel) {
      panel.classList.remove('open');
      isPanelOpen = false;
    }
  }
}

function isExtensionContextValid() {
  try { return chrome.runtime && !!chrome.runtime.id; }
  catch { return false; }
}

async function scrapeCurrentProfile() {
  if (!window.location.href.includes('linkedin.com/in/')) return { scraped: false };
  if (!isExtensionContextValid()) return { scraped: false };

  const now = Date.now();
  if (now - lastScrapeTimestamp < SCRAPE_COOLDOWN_MS) return { scraped: false };

  try {
    dispatchProgress('authenticating', 5);
    const response = await chrome.runtime.sendMessage({ action: 'checkAuth' });
    if (!response?.authenticated) return { scraped: false };

    dispatchProgress('scrolling', 15);
    const scraper = new window.LinkedInScraper();
    const cleanedText = await scraper.scrapeAndClean();
    const photoUrl = scraper.extractProfilePhotoUrl();

    if (!isExtensionContextValid()) return { scraped: false };

    dispatchProgress('parsing', 60);
    const parseResponse = await chrome.runtime.sendMessage({
      action: 'parseProfile',
      data: { cleanedText, profileUrl: window.location.href }
    });

    if (parseResponse?.error) {
      // Don't start the scrape cooldown on a failed parse — a retry should be
      // possible immediately (the manual Analyze button resets it anyway).
      return {
        scraped: false,
        parseError: {
          message: parseResponse.error,
          code: parseResponse.code,
          status: parseResponse.status
        }
      };
    }

    lastScrapeTimestamp = Date.now();
    return { scraped: true, profileData: parseResponse?.profileData || null, photoUrl };
  } catch (error) {
    return { scraped: false };
  }
}

// ---- Navigation detection ----

let lastProfileId = extractProfileId(window.location.href);

function extractProfileId(url) {
  const match = url.match(/linkedin\.com\/in\/([^/?]+)/);
  return match ? match[1] : null;
}

function updateFabVisibility() {
  const fab = document.getElementById('_cv-f');
  if (fab) {
    fab.style.display = extractProfileId(window.location.href) ? '' : 'none';
  }
}

function handleProfileNavigation() {
  updateFabVisibility();

  const currentProfileId = extractProfileId(window.location.href);

  if (currentProfileId && currentProfileId !== lastProfileId) {
    lastProfileId = currentProfileId;
    isAnalyzing = false;
    lastAnalyzedProfileId = null;
    lastScrapeTimestamp = 0;

    // Always check DB for the new profile (fast, no page interaction)
    checkProfileInDB(currentProfileId);

    if (isPanelOpen) {
      tryLoadFromCache(currentProfileId).then((hit) => {
        if (!hit) {
          emit('newprofile', { profileId: currentProfileId });
          if (autoScrapeEnabled) {
            analyzeCurrentProfile(currentProfileId, true);
          }
        }
      }).catch(() => {
        emit('newprofile', { profileId: currentProfileId });
      });
    } else {
      emit('newprofile', { profileId: currentProfileId });
    }
  } else if (!currentProfileId && lastProfileId) {
    lastProfileId = null;
    isAnalyzing = false;
    lastAnalyzedProfileId = null;

    emit('leftprofile');
  }
}

// ---- Init ----

if (!window.__cv_init) {
  window.__cv_init = true;

  // React panel announces its listeners are attached — safe to push state.
  _bus.addEventListener('panel-ready', () => {
    syncPanelState();
  });

  _bus.addEventListener('request-scrape', () => {
    const currentProfileId = extractProfileId(window.location.href);
    if (currentProfileId && !isAnalyzing) {
      lastAnalyzedProfileId = null;
      lastScrapeTimestamp = 0;
      analyzeCurrentProfile(currentProfileId);
    }
  });

  window.addEventListener('popstate', handleProfileNavigation);

  let lastPolledUrl = window.location.href;
  setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastPolledUrl) {
      lastPolledUrl = currentUrl;
      handleProfileNavigation();
    }
  }, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createFAB);
} else {
  createFAB();
}

window.__cv_close = closePanel;
