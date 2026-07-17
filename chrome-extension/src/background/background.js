/**
 * Background Service Worker for CareerVine Extension
 * Handles API communication and authentication
 */

// Load environment configuration
// Change this to 'production' before building for Chrome Web Store
const ENV = 'development';

let config = {};
let configPromise = null;

// Initialize configuration (singleton — safe to call concurrently).
// The packaged env file (env/<ENV>.json) is the single source of truth for
// every endpoint and key. There is no inline fallback: a missing or unreadable
// env file is a broken build, so we fail loudly rather than silently connecting
// to a hardcoded production stack (which once let dev builds hit prod).
function ensureConfig() {
  if (!configPromise) {
    configPromise = (async () => {
      const url = chrome.runtime.getURL(`env/${ENV}.json`);
      let response;
      try {
        response = await fetch(url);
      } catch (error) {
        // Reset so a transient failure can be retried on the next call.
        configPromise = null;
        throw new Error(`CareerVine: failed to load packaged env config (${url}): ${error.message}`);
      }
      if (!response.ok) {
        configPromise = null;
        throw new Error(`CareerVine: packaged env config missing or unreadable (${url}): HTTP ${response.status}`);
      }
      try {
        config = await response.json();
      } catch (error) {
        configPromise = null;
        throw new Error(`CareerVine: packaged env config is not valid JSON (${url}): ${error.message}`);
      }
    })();
  }
  return configPromise;
}

// ── Product analytics (CAR-38) ─────────────────────────────────────────
// Minimal PostHog capture over fetch — no SDK in the service worker.
// No-ops when posthogKey is empty (until the PostHog project is provisioned).
// Anonymous device id until login; merged into the user via $create_alias.

async function analyticsDistinctId() {
  const { session } = await chrome.storage.local.get(['session']);
  if (session?.user?.id) return session.user.id;
  const { anonId } = await chrome.storage.local.get(['anonId']);
  if (anonId) return anonId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ anonId: fresh });
  return fresh;
}

async function trackEvent(event, properties = {}, distinctIdOverride = null) {
  try {
    await ensureConfig();
    if (!config.posthogKey) return;
    // Internal accounts (Dawson/test users) are excluded from analytics (CAR-80).
    // "internal" is an email-derived app_metadata claim on the Supabase session,
    // captured into storage at login/refresh — survives account delete/recreate.
    const { session } = await chrome.storage.local.get(['session']);
    if (session?.user?.is_internal) return;
    const distinctId = distinctIdOverride || (await analyticsDistinctId());
    await fetch(`${config.posthogHost}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.posthogKey,
        event,
        distinct_id: distinctId,
        properties: { ...properties, surface: 'extension' },
        timestamp: new Date().toISOString()
      })
    });
  } catch (error) {
    // Analytics must never break the extension
    console.warn('Analytics capture failed:', error.message);
  }
}

// Extract only the fields we need from a raw Supabase session
function buildStoredSession(raw) {
  return {
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: raw.expires_at,
    user: {
      id: raw.user?.id,
      email: raw.user?.email,
      // CAR-80: email-derived analytics-exclusion flag, carried on the JWT as an
      // app_metadata claim. Captured here so trackEvent can drop internal accounts;
      // refreshed with the token, so it survives account delete/recreate.
      is_internal: raw.user?.app_metadata?.is_internal === true
    }
  };
}

// Attempt to refresh an expired session using the refresh token
async function refreshSession(session) {
  try {
    const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseAnonKey
      },
      body: JSON.stringify({
        refresh_token: session.refresh_token
      })
    });

    if (!response.ok) {
      return null;
    }

    const newSession = await response.json();
    const storedSession = buildStoredSession(newSession);

    await chrome.storage.local.set({ session: storedSession });

    return storedSession;
  } catch (error) {
    console.error('Token refresh failed:', error);
    return null;
  }
}

// Single-flight guard: Supabase rotates refresh tokens, so two concurrent
// refreshes with the same token can revoke the whole session. Concurrent
// callers share one in-flight refresh instead.
let refreshPromise = null;

// Get a valid session, refreshing if expired
async function getValidSession() {
  const { session } = await chrome.storage.local.get(['session']);
  if (!session) return null;

  // Check if token needs refresh (expired, about to expire, or missing expires_at)
  const isExpired = session.expires_at == null ||
    Date.now() > session.expires_at * 1000 - 60000;

  if (isExpired) {
    if (session.refresh_token) {
      if (!refreshPromise) {
        refreshPromise = refreshSession(session).finally(() => {
          refreshPromise = null;
        });
      }
      const refreshed = await refreshPromise;
      if (refreshed) return refreshed;
    }
    await chrome.storage.local.remove(['session']);
    return null;
  }

  return session;
}

// Handle messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ensure config is loaded before handling message
  (async () => {
    await ensureConfig();

    try {
      switch (message.action) {
      case 'parseProfile':
        await handleParseProfile(message.data, sendResponse);
        break;
      case 'importData':
        await handleImportData(message.data, message.photoUrl, sendResponse);
        break;
      case 'authenticate':
        await handleAuthentication(message.credentials, sendResponse);
        break;
      case 'checkAuth':
        await checkAuthentication(sendResponse);
        break;
      case 'logout':
        await handleLogout(sendResponse);
        break;
      case 'getConfig':
        sendResponse({ apiBaseUrl: config.apiBaseUrl, environment: config.environment });
        break;
      case 'checkDuplicate':
        await handleCheckDuplicate(message.data, sendResponse);
        break;
      default:
        sendResponse({ error: 'Unknown action' });
    }
  } catch (error) {
      console.error('Background script error:', error);
      sendResponse({ error: error.message });
    }
  })();

  // Return true to indicate async response
  return true;
});

// Authenticated POST to the CareerVine API
async function authenticatedPost(path, body) {
  const session = await getValidSession();
  if (!session) throw new Error('Not authenticated. Please sign in first.');

  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const error = new Error(errorData.error || `HTTP ${response.status}`);
    // Preserve the machine-readable failure info (e.g. CAR-26 AI-availability
    // codes over 402) so callers can surface a specific state, not a string.
    error.code = errorData.code;
    error.status = response.status;
    error.resetAt = errorData.resetAt;
    throw error;
  }

  return response.json();
}

async function handleParseProfile(data, sendResponse) {
  try {
    const result = await authenticatedPost('/extension/parse-profile', {
      cleanedText: data.cleanedText,
      profileUrl: data.profileUrl
    });

    // Profile data flows back to the calling tab's content script, which
    // caches it per-profile and hands it to its own panel over the bus.
    // Nothing is written to global storage — that's what let one tab's
    // scrape overwrite another tab's panel.
    trackEvent('profile_scraped');
    sendResponse({ success: true, profileData: result.profileData });
  } catch (error) {
    sendResponse({ error: error.message, code: error.code, status: error.status, resetAt: error.resetAt });
  }
}

async function handleImportData(data, photoUrl, sendResponse) {
  try {
    // photoUrl is passed directly from the panel — no global storage read needed
    const importPayload = { profileData: data };
    if (photoUrl) {
      importPayload.photoUrl = photoUrl;
    }
    const result = await authenticatedPost('/contacts/import', importPayload);

    // Add to recent contacts in storage
    const { recentContacts = [] } = await chrome.storage.local.get(['recentContacts']);
    const contactEntry = {
      name: data.name || `${data.first_name || ''} ${data.last_name || ''}`.trim(),
      headline: data.industry || '',
      company: data.current_company || '',
      school: data.education?.[0]?.school || '',
      linkedin_url: data.linkedin_url || '',
      importedAt: new Date().toISOString()
    };
    const updatedContacts = [
      contactEntry,
      ...recentContacts.filter(c => c.linkedin_url !== contactEntry.linkedin_url)
    ].slice(0, 10);
    await chrome.storage.local.set({ recentContacts: updatedContacts });

    sendResponse({ success: true, data: result });
  } catch (error) {
    sendResponse({ error: error.message });
  }
}

async function handleAuthentication(credentials, sendResponse) {
  try {
    // Call Supabase auth endpoint
    const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseAnonKey
      },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error_description || errorData.error || 'Authentication failed');
    }

    const fullSession = await response.json();
    const storedSession = buildStoredSession(fullSession);

    // Persist the session first so trackEvent can see the is_internal claim
    // (CAR-80) and drop analytics for internal accounts, including these two
    // login events.
    await chrome.storage.local.set({ session: storedSession });

    // Merge the anonymous install identity into the real user, then record
    // the login (CAR-38 onboarding funnel).
    const { anonId } = await chrome.storage.local.get(['anonId']);
    if (anonId && storedSession.user?.id) {
      await trackEvent('$create_alias', { distinct_id: storedSession.user.id, alias: anonId }, storedSession.user.id);
    }
    await trackEvent('extension_logged_in', {}, storedSession.user?.id);

    // Announce the connection so the web app's extension-onboarding step
    // (CAR-68) advances immediately. Fire-and-forget — login must not fail
    // or slow down because the ping did. Forced past the throttle: a fresh
    // login is exactly the signal the onboarding connect step waits on.
    pingCareerVine(true);

    // Return session without refresh_token to the popup
    sendResponse({
      success: true,
      session: {
        access_token: storedSession.access_token,
        user: storedSession.user
      }
    });

  } catch (error) {
    console.error('Authentication error:', error);
    sendResponse({ error: error.message });
  }
}

async function checkAuthentication(sendResponse) {
  try {
    const session = await getValidSession();

    if (!session) {
      sendResponse({ authenticated: false });
      return;
    }

    // Already-logged-in users (who never re-auth) still stamp last-seen for
    // the CAR-68 onboarding connect step. Throttled; never blocks the check.
    pingCareerVine();

    // Token is valid (checked locally + refreshed if needed)
    sendResponse({ authenticated: true, user: session.user });

  } catch (error) {
    console.error('Auth check error:', error);
    sendResponse({ authenticated: false });
  }
}

// CAR-68: liveness ping → stamps users.extension_last_seen_at server-side.
// Throttled so popup-open auth checks don't spam the API.
const PING_THROTTLE_MS = 5 * 60 * 1000;
async function pingCareerVine(force = false) {
  try {
    const { lastPingAt } = await chrome.storage.local.get(['lastPingAt']);
    if (!force && lastPingAt && Date.now() - lastPingAt < PING_THROTTLE_MS) return;
    await chrome.storage.local.set({ lastPingAt: Date.now() });
    await authenticatedPost('/extension/ping', {});
  } catch (error) {
    // Best-effort by design; the API also stamps last-seen on any real call.
    console.warn('CareerVine ping failed:', error.message);
  }
}

async function handleCheckDuplicate(data, sendResponse) {
  try {
    const result = await authenticatedPost('/contacts/check-duplicate', {
      linkedinUrl: data.linkedinUrl,
      name: data.name
    });
    sendResponse({ success: true, duplicates: result.duplicates || [] });
  } catch (error) {
    // error flag lets the content script skip caching this as "no match"
    // (e.g. the check ran while signed out and should retry after login)
    sendResponse({ duplicates: [], error: error.message });
  }
}

async function handleLogout(sendResponse) {
  try {
    // latestProfile/latestPhotoUrl are legacy keys — kept in the remove list
    // so stale installs get cleaned up.
    await chrome.storage.local.remove(['session', 'latestProfile', 'latestPhotoUrl', 'recentContacts', 'autoScrapeEnabled', 'profileCache']);
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ error: error.message });
  }
}

// Handle extension installation
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('CareerVine Extension installed');

    // Initialize configuration
    await ensureConfig();

    // Set default values
    await chrome.storage.local.set({ session: null });

    // Onboarding funnel start (CAR-38) — anonymous until first login
    await trackEvent('extension_installed');
  }
});

// Handle extension startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('CareerVine Extension started');
  await ensureConfig();
});
