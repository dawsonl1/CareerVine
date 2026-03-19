/**
 * CareerVine Content Script
 * Handles LinkedIn profile scraping and slide-out panel UI
 */

// State
let isPanelOpen = false;
let isAnalyzing = false;
let lastAnalyzedProfileId = null;
let lastScrapeTimestamp = 0;
const SCRAPE_COOLDOWN_MS = 30000; // 30 seconds minimum between scrapes

// Create and inject the slide-out panel with Shadow DOM isolation
function createPanel() {
  // Check if panel already exists
  if (document.getElementById('careervine-panel-host')) {
    return;
  }

  // Create host element for Shadow DOM
  const host = document.createElement('div');
  host.id = 'careervine-panel-host';
  host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647; height: 100vh; pointer-events: none;';
  document.body.appendChild(host);

  // Create Shadow DOM for complete style isolation
  const shadow = host.attachShadow({ mode: 'open' });

  // Create panel container inside shadow
  const panel = document.createElement('div');
  panel.id = 'careervine-panel';
  panel.className = 'careervine-panel';
  panel.style.cssText = 'pointer-events: auto;';
  panel.innerHTML = `<div id="root"></div>`;
  shadow.appendChild(panel);

  // Make panel visible immediately
  setTimeout(() => {
    panel.classList.add('open');
    isPanelOpen = true;
    console.log('CareerVine panel opened');
  }, 100);

  // Load React panel bundle into shadow DOM
  loadPanelScript(shadow);
}

function loadPanelScript(shadowRoot) {
  // Define process.env for React bundle
  window.process = { env: { NODE_ENV: 'production' } };
  
  // Store shadow root globally for the panel script
  window.__careervine_shadow_root = shadowRoot;
  
  // Import the panel script as a module in the content script context
  // This keeps it in the same isolated world where we have access to shadowRoot
  import(chrome.runtime.getURL('src/content/panel-app/panel.js'))
    .catch(error => {
      console.error('CareerVine: Failed to load panel script:', error);
    });
}

// Create the floating action button
function createFAB() {
  if (document.getElementById('careervine-fab')) {
    return;
  }

  const fab = document.createElement('button');
  fab.id = 'careervine-fab';
  fab.className = 'careervine-fab';
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

function openPanel() {
  createPanel();
  const host = document.getElementById('careervine-panel-host');
  if (host && host.shadowRoot) {
    const panel = host.shadowRoot.getElementById('careervine-panel');
    if (panel) {
      panel.classList.add('open');
      isPanelOpen = true;
      
      // Check if we need to analyze a new profile (user clicked FAB)
      const currentProfileId = extractProfileId(window.location.href);
      if (currentProfileId && currentProfileId !== lastAnalyzedProfileId) {
        // Set analyzing state and notify React panel
        isAnalyzing = true;
        const event = new CustomEvent('careervine:analyzing', { detail: { analyzing: true } });
        window.dispatchEvent(event);

        // Start analysis (user-initiated via FAB click)
        scrapeCurrentProfile().then((result) => {
          isAnalyzing = false;
          // Only mark as analyzed if the scrape actually ran
          if (result?.scraped) {
            lastAnalyzedProfileId = currentProfileId;
          }
          const doneEvent = new CustomEvent('careervine:analyzing', { detail: { analyzing: false } });
          window.dispatchEvent(doneEvent);
        }).catch(() => {
          isAnalyzing = false;
          const doneEvent = new CustomEvent('careervine:analyzing', { detail: { analyzing: false } });
          window.dispatchEvent(doneEvent);
        });
      }
    }
  }
}

function closePanel() {
  console.log('CareerVine: closePanel called');
  const host = document.getElementById('careervine-panel-host');
  if (host && host.shadowRoot) {
    const panel = host.shadowRoot.getElementById('careervine-panel');
    if (panel) {
      panel.classList.remove('open');
      isPanelOpen = false;
      console.log('CareerVine: panel closed');
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

// Scrape the current LinkedIn profile (only triggered by user action)
// Returns { scraped: true } on success, { scraped: false } otherwise
async function scrapeCurrentProfile() {
  if (!window.location.href.includes('linkedin.com/in/')) return { scraped: false };
  if (!isExtensionContextValid()) {
    console.log('CareerVine: Extension context invalidated, skipping scrape');
    return { scraped: false };
  }

  // Throttle: enforce minimum cooldown between scrapes
  const now = Date.now();
  const timeSinceLastScrape = now - lastScrapeTimestamp;
  if (timeSinceLastScrape < SCRAPE_COOLDOWN_MS) {
    const waitSeconds = Math.ceil((SCRAPE_COOLDOWN_MS - timeSinceLastScrape) / 1000);
    console.log(`CareerVine: Please wait ${waitSeconds}s before scraping again`);
    return { scraped: false };
  }

  try {
    const response = await chrome.runtime.sendMessage({ action: 'checkAuth' });
    if (!response?.authenticated) {
      console.log('CareerVine: Not authenticated, skipping scrape');
      return { scraped: false };
    }

    const scraper = new window.LinkedInScraper();
    const cleanedText = await scraper.scrapeAndClean();

    if (!isExtensionContextValid()) return { scraped: false };

    await chrome.runtime.sendMessage({
      action: 'parseProfile',
      data: {
        cleanedText,
        profileUrl: window.location.href
      }
    });

    // Only set timestamp after successful scrape
    lastScrapeTimestamp = Date.now();
    return { scraped: true };
  } catch (error) {
    if (error.message?.includes('Extension context invalidated')) {
      console.log('CareerVine: Extension was reloaded, please refresh the page');
    } else {
      console.error('CareerVine: Scrape failed:', error);
    }
    return { scraped: false };
  }
}

// Listen for navigation changes (SPA)
let lastProfileId = extractProfileId(window.location.href);

function extractProfileId(url) {
  const match = url.match(/linkedin\.com\/in\/([^/?]+)/);
  return match ? match[1] : null;
}

// Detect navigation to reset state (no auto-scraping — user must click FAB)
function handleProfileNavigation() {
  const currentProfileId = extractProfileId(window.location.href);

  if (currentProfileId && currentProfileId !== lastProfileId) {
    lastProfileId = currentProfileId;
    // Close panel when navigating to new profile so user can re-open to scrape
    if (isPanelOpen) {
      closePanel();
    }
    // Reset all analysis/throttle state for new profile
    isAnalyzing = false;
    lastAnalyzedProfileId = null;
    lastScrapeTimestamp = 0;
  }
}

// Detect SPA navigation via History API hooks and popstate
window.addEventListener('popstate', handleProfileNavigation);

// Guard against double-initialization if content script runs twice
if (!window.__careervine_initialized) {
  window.__careervine_initialized = true;

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    handleProfileNavigation();
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    handleProfileNavigation();
  };
}

// Initialize when DOM is ready (no auto-scraping — user clicks FAB to scrape)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createFAB);
} else {
  createFAB();
}

// Expose for manual triggering
window.CareerVinePanel = {
  open: openPanel,
  close: closePanel,
  toggle: togglePanel
};
