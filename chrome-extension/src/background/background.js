/**
 * Background Service Worker for CareerVine Extension
 * Handles API communication and authentication
 */

// Load environment configuration
// Change this to 'production' before building for Chrome Web Store
const ENV = 'development';

let config = {};

// Initialize configuration
async function initializeConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL(`env/${ENV}.json`));
    config = await response.json();
    console.log(`CareerVine: Loaded ${config.environment} config -> ${config.apiBaseUrl}`);
  } catch (error) {
    console.error('Failed to load config:', error);
    config = {
      apiBaseUrl: 'https://dawsonsprojects.com/api',
      supabaseUrl: 'https://iycrlwqjetkwaauzxrhd.supabase.co',
      supabaseAnonKey: 'sb_publishable_1WPOaIis1MzOM3SUuW1wMw_l5ZGr3n3',
      environment: 'production'
    };
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
      email: raw.user?.email
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

// Get a valid session, refreshing if expired
async function getValidSession() {
  const { session } = await chrome.storage.local.get(['session']);
  if (!session) return null;

  // Check if token has expired (with 60s buffer)
  // Treat missing expires_at as expired to force a refresh
  if (session.expires_at != null) {
    const expiresAt = session.expires_at * 1000; // Supabase uses seconds
    if (Date.now() > expiresAt - 60000) {
      // Token expired or about to expire — try refresh
      if (session.refresh_token) {
        const refreshed = await refreshSession(session);
        if (refreshed) return refreshed;
      }
      // Refresh failed — clear session
      await chrome.storage.local.remove(['session']);
      return null;
    }
  } else {
    // No expires_at — treat as expired, try refresh
    if (session.refresh_token) {
      const refreshed = await refreshSession(session);
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
    if (!config.supabaseUrl) {
      await initializeConfig();
    }

    try {
      switch (message.action) {
      case 'parseProfile':
        await handleParseProfile(message.data, sendResponse);
        break;
      case 'importData':
        await handleImportData(message.data, sendResponse);
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
      case 'getLatestProfile':
        await handleGetLatestProfile(sendResponse);
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

async function handleParseProfile(data, sendResponse) {
  try {
    const session = await getValidSession();

    if (!session) {
      sendResponse({ error: 'Not authenticated. Please sign in first.' });
      return;
    }

    // Call API to parse profile with OpenAI
    const response = await fetch(`${config.apiBaseUrl}/extension/parse-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        cleanedText: data.cleanedText,
        profileUrl: data.profileUrl
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    const result = await response.json();

    // Cache the latest profile for React panel
    await chrome.storage.local.set({ latestProfile: result.profileData });

    sendResponse({ success: true, profileData: result.profileData });

  } catch (error) {
    console.error('Parse profile error:', error);
    sendResponse({ error: error.message });
  }
}

async function handleImportData(data, sendResponse) {
  try {
    const session = await getValidSession();

    if (!session) {
      sendResponse({ error: 'Not authenticated. Please sign in first.' });
      return;
    }

    // Call API to import data
    const response = await fetch(`${config.apiBaseUrl}/contacts/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        profileData: data
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    const result = await response.json();

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
    console.error('Import error:', error);
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

    await chrome.storage.local.set({ session: storedSession });

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

    // Token is valid (checked locally + refreshed if needed)
    sendResponse({ authenticated: true, user: session.user });

  } catch (error) {
    console.error('Auth check error:', error);
    sendResponse({ authenticated: false });
  }
}

async function handleLogout(sendResponse) {
  try {
    await chrome.storage.local.remove(['session', 'latestProfile', 'recentContacts', 'autoScrapeEnabled']);
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ error: error.message });
  }
}

async function handleGetLatestProfile(sendResponse) {
  try {
    const { latestProfile } = await chrome.storage.local.get(['latestProfile']);
    sendResponse({ profileData: latestProfile });
  } catch (error) {
    console.error('Get latest profile error:', error);
    sendResponse({ error: error.message });
  }
}

// Handle extension installation
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('CareerVine Extension installed');

    // Initialize configuration
    await initializeConfig();

    // Set default values
    await chrome.storage.local.set({ session: null });
  }
});

// Handle extension startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('CareerVine Extension started');
  await initializeConfig();
});
