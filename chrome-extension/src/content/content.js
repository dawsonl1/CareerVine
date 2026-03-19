/**
 * CareerVine Content Script
 * Handles LinkedIn profile scraping and slide-out panel UI
 */

// State
let isPanelOpen = false;
let isAnalyzing = false;
let lastAnalyzedProfileId = null;
let lastScrapeTimestamp = 0;
let autoScrapeEnabled = false;
const SCRAPE_COOLDOWN_MS = 30000;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Load and cache auto-scrape setting, update via storage change listener
chrome.storage.local.get(['autoScrapeEnabled'], (result) => {
  autoScrapeEnabled = result.autoScrapeEnabled || false;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.autoScrapeEnabled) {
    autoScrapeEnabled = changes.autoScrapeEnabled.newValue || false;
  }
});

// Private event bus — NOT on window, so LinkedIn's JS can never listen to it
const _bus = new EventTarget();

function emit(name, detail = {}) {
  _bus.dispatchEvent(new CustomEvent(name, { detail }));
}

// Expose event bus to the React panel (isolated world only — not visible to page JS)
window.__cv_bus = _bus;

// Store closed shadow root reference (isolated world only)
let _shadowRoot = null;

// Create and inject the slide-out panel with Shadow DOM isolation
function createPanel() {
  if (document.getElementById('_cv-ph')) {
    return;
  }

  const host = document.createElement('div');
  host.id = '_cv-ph';
  host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647; height: 100vh; pointer-events: none;';
  document.body.appendChild(host);

  // Closed shadow DOM — LinkedIn cannot inspect contents
  const shadow = host.attachShadow({ mode: 'closed' });
  _shadowRoot = shadow;

  const panel = document.createElement('div');
  panel.id = '_cv-p';
  panel.className = 'careervine-panel';  // Inside shadow DOM — not visible to LinkedIn
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

  import(chrome.runtime.getURL('src/content/panel-app/panel.js'))
    .catch(() => {});
}

// Create the floating action button
function createFAB() {
  if (document.getElementById('_cv-f')) {
    return;
  }

  const fab = document.createElement('button');
  fab.id = '_cv-f';
  fab.className = '_cv-f';
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
  if (isPanelOpen) {
    closePanel();
  } else {
    openPanel();
  }
}

// Profile cache — avoids re-scraping recently viewed profiles
async function getCachedProfile(profileId) {
  const { profileCache = {} } = await chrome.storage.local.get(['profileCache']);
  const entry = profileCache[profileId];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    return entry.data;
  }
  return null;
}

async function setCachedProfile(profileId, data) {
  const { profileCache = {} } = await chrome.storage.local.get(['profileCache']);
  // Clean expired entries while we're here
  const now = Date.now();
  const cleaned = {};
  for (const [key, val] of Object.entries(profileCache)) {
    if (now - val.timestamp < CACHE_TTL_MS) {
      cleaned[key] = val;
    }
  }
  cleaned[profileId] = { data, timestamp: now };
  await chrome.storage.local.set({ profileCache: cleaned });
}

// Try loading a profile from cache, returns true if cache hit
async function tryLoadFromCache(profileId) {
  const cached = await getCachedProfile(profileId);
  if (cached) {
    await chrome.storage.local.set({ latestProfile: cached });
    lastAnalyzedProfileId = profileId;
    emit('cachedhit');
    return true;
  }
  return false;
}

// Dispatch progress updates via private bus
function dispatchProgress(stage, percent) {
  emit('progress', { stage, percent });
}

// Trigger scrape and notify the React panel of progress
function analyzeCurrentProfile(profileId, calledFromNav = false) {
  isAnalyzing = true;
  emit('analyzing', { analyzing: true });
  dispatchProgress('starting', 0);

  const doScrape = () => {
    scrapeCurrentProfile().then(async (result) => {
      isAnalyzing = false;
      if (result?.scraped) {
        lastAnalyzedProfileId = profileId;
        // Cache the scraped profile for future visits
        const { latestProfile } = await chrome.storage.local.get(['latestProfile']);
        if (latestProfile) {
          await setCachedProfile(profileId, latestProfile);
        }
      }
      dispatchProgress('done', 100);
      emit('analyzing', { analyzing: false });
    }).catch(() => {
      isAnalyzing = false;
      dispatchProgress('error', 0);
      emit('analyzing', { analyzing: false });
    });
  };

  if (calledFromNav) {
    setTimeout(doScrape, 1000);
  } else {
    doScrape();
  }
}

function openPanel() {
  createPanel();
  if (_shadowRoot) {
    const panel = _shadowRoot.getElementById('_cv-p');
    if (panel) {
      panel.classList.add('open');
      isPanelOpen = true;

      const currentProfileId = extractProfileId(window.location.href);
      if (currentProfileId && currentProfileId !== lastAnalyzedProfileId) {
        // Try cache first — if hit, profile loads instantly
        tryLoadFromCache(currentProfileId).then((hit) => {
          if (!hit && autoScrapeEnabled) {
            analyzeCurrentProfile(currentProfileId);
          }
        });
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

// Check if extension context is still valid
function isExtensionContextValid() {
  try {
    return chrome.runtime && !!chrome.runtime.id;
  } catch {
    return false;
  }
}

// Scrape the current LinkedIn profile
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

    if (!isExtensionContextValid()) return { scraped: false };

    dispatchProgress('parsing', 60);
    await chrome.runtime.sendMessage({
      action: 'parseProfile',
      data: { cleanedText, profileUrl: window.location.href }
    });

    dispatchProgress('done', 100);
    lastScrapeTimestamp = Date.now();
    return { scraped: true };
  } catch (error) {
    return { scraped: false };
  }
}

// Navigation detection
let lastProfileId = extractProfileId(window.location.href);

function extractProfileId(url) {
  const match = url.match(/linkedin\.com\/in\/([^/?]+)/);
  return match ? match[1] : null;
}

function handleProfileNavigation() {
  const currentProfileId = extractProfileId(window.location.href);

  if (currentProfileId && currentProfileId !== lastProfileId) {
    // Navigated to a new profile
    lastProfileId = currentProfileId;
    isAnalyzing = false;
    lastAnalyzedProfileId = null;
    lastScrapeTimestamp = 0;

    chrome.storage.local.remove(['latestProfile']);

    if (isPanelOpen) {
      // Try cache first — if hit, profile loads instantly with no scrape needed
      tryLoadFromCache(currentProfileId).then((hit) => {
        if (!hit) {
          emit('newprofile');
          if (autoScrapeEnabled) {
            analyzeCurrentProfile(currentProfileId, true);
          }
        }
      });
    } else {
      emit('newprofile');
    }
  } else if (!currentProfileId && lastProfileId) {
    // Left a profile page (went to timeline, search, etc.)
    lastProfileId = null;
    isAnalyzing = false;
    lastAnalyzedProfileId = null;

    chrome.storage.local.remove(['latestProfile']);
    emit('leftprofile');
  }
}

// Guard against double-initialization
if (!window.__cv_init) {
  window.__cv_init = true;

  // Listen for manual scrape requests from the React panel (private bus)
  _bus.addEventListener('request-scrape', () => {
    const currentProfileId = extractProfileId(window.location.href);
    if (currentProfileId && !isAnalyzing) {
      lastAnalyzedProfileId = null;
      analyzeCurrentProfile(currentProfileId);
    }
  });

  window.addEventListener('popstate', handleProfileNavigation);

  // Poll for URL changes — LinkedIn SPA navigation detection
  let lastPolledUrl = window.location.href;
  setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastPolledUrl) {
      lastPolledUrl = currentUrl;
      handleProfileNavigation();
    }
  }, 1000);
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createFAB);
} else {
  createFAB();
}

// Expose close function for panel (isolated world only)
window.__cv_close = closePanel;
