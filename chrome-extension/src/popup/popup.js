/**
 * CareerVine Extension Popup Logic
 * Auth + a focused, context-aware signed-in view.
 */

const WEBAPP_BASE = 'https://www.careervine.app';

const ICON_PROFILE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

class PopupManager {
  constructor() {
    this.api = new CareerVineAPI();
    this.storage = new StorageHelper();
    this.init();
  }

  async init() {
    this.setupEventListeners();

    const versionEl = document.querySelector('.app-version');
    if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

    await this.checkAuthStatus();
  }

  setupEventListeners() {
    document.getElementById('authForm')?.addEventListener('submit', (e) => this.handleSignIn(e));

    // Clear the error as soon as the user edits either field.
    document.getElementById('email')?.addEventListener('input', () => this.clearError());
    document.getElementById('password')?.addEventListener('input', () => this.clearError());

    document.getElementById('togglePassword')?.addEventListener('click', () => this.togglePassword());

    document.getElementById('signupLink')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: `${WEBAPP_BASE}/auth?mode=signup` });
    });
    document.getElementById('forgotLink')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: `${WEBAPP_BASE}/auth?mode=reset` });
    });

    document.getElementById('openAppBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: WEBAPP_BASE });
    });

    document.getElementById('importBtn')?.addEventListener('click', () => this.importCurrentProfile());
    document.getElementById('signOutBtn')?.addEventListener('click', () => this.handleSignOut());
  }

  // ----- View switching -----

  show(view) {
    document.getElementById('authSection').style.display = view === 'auth' ? 'flex' : 'none';
    document.getElementById('mainSection').style.display = view === 'main' ? 'flex' : 'none';
    document.getElementById('loadingSection').style.display = view === 'loading' ? 'flex' : 'none';
  }

  async checkAuthStatus() {
    this.show('loading');
    try {
      const { authenticated, user } = await this.api.checkAuth();
      if (authenticated) {
        this.showMain(user);
      } else {
        this.show('auth');
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      this.show('auth');
    }
  }

  async showMain(user) {
    this.show('main');

    const email = user?.email || '';
    const initial = email ? email[0].toUpperCase() : '?';
    const avatar = document.getElementById('userAvatar');
    document.getElementById('avatarInitial').textContent = initial;
    if (avatar && email) avatar.title = email;

    await Promise.all([this.renderPageCard(), this.loadRecentContacts()]);
  }

  // ----- Sign in -----

  async handleSignIn(e) {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const btn = document.getElementById('signInBtn');

    if (!email || !password) return;

    this.setLoading(btn, true, 'Signing in…');
    this.clearError();
    try {
      await this.api.authenticate(email, password);
      await this.checkAuthStatus();
    } catch (error) {
      this.showError(this.friendlyAuthError(error.message));
      this.setLoading(btn, false, 'Sign in');
    }
  }

  friendlyAuthError(message) {
    const m = (message || '').toLowerCase();
    if (m.includes('invalid') || m.includes('credentials')) {
      return 'That email or password is incorrect. Please try again.';
    }
    if (m.includes('network') || m.includes('failed to fetch')) {
      return 'Could not reach CareerVine. Check your connection and try again.';
    }
    return message || 'Sign in failed. Please try again.';
  }

  togglePassword() {
    const input = document.getElementById('password');
    const btn = document.getElementById('togglePassword');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.querySelector('.icon-eye').style.display = show ? 'none' : 'block';
    btn.querySelector('.icon-eye-off').style.display = show ? 'block' : 'none';
  }

  async handleSignOut() {
    try {
      await this.api.logout();
    } catch (error) {
      console.error('Sign out failed:', error);
    }
    document.getElementById('email').value = '';
    document.getElementById('password').value = '';
    this.clearError();
    this.show('auth');
  }

  // ----- Signed-in: current page -----

  async renderPageCard() {
    const card = document.getElementById('pageCard');
    const iconEl = document.getElementById('pageCardIcon');
    const titleEl = document.getElementById('pageCardTitle');
    const subEl = document.getElementById('pageCardSub');
    const importBtn = document.getElementById('importBtn');

    let onProfile = false;
    let name = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this._activeTabId = tab?.id ?? null;
      onProfile = !!tab?.url && /linkedin\.com\/in\//.test(tab.url);
      name = this.profileNameFromTitle(tab?.title);
    } catch (error) {
      console.error('Failed to read current tab:', error);
    }

    if (onProfile) {
      card.classList.add('is-active');
      iconEl.innerHTML = ICON_PROFILE;
      titleEl.textContent = name || 'LinkedIn profile';
      subEl.textContent = 'Ready to import into CareerVine';
      importBtn.style.display = '';
    } else {
      card.classList.remove('is-active');
      iconEl.innerHTML = ICON_SEARCH;
      titleEl.textContent = 'Import from LinkedIn';
      subEl.textContent = 'Open any profile, then import them here';
      importBtn.style.display = 'none';
    }
  }

  profileNameFromTitle(title) {
    if (!title) return '';
    // LinkedIn profile titles look like "(3) Jane Doe | LinkedIn".
    const cleaned = title.replace(/^\(\d+\)\s*/, '').split('|')[0].trim();
    return cleaned && !/^linkedin$/i.test(cleaned) ? cleaned : '';
  }

  importCurrentProfile() {
    if (this._activeTabId == null) return;
    // The panel lives in the LinkedIn tab's content script; ask it to open.
    // Fire-and-forget: if the content script isn't ready we simply close.
    try {
      chrome.tabs.sendMessage(this._activeTabId, { action: 'openPanel' }, () => void chrome.runtime.lastError);
    } catch (error) {
      console.error('Failed to open panel:', error);
    }
    window.close();
  }

  // ----- Signed-in: recent imports -----

  async loadRecentContacts() {
    const container = document.getElementById('recentContacts');
    let recent = [];
    try {
      recent = await this.storage.getRecentContacts();
    } catch (error) {
      console.error('Failed to load recent contacts:', error);
    }

    if (!recent.length) return; // keep the static empty state already in the DOM

    container.innerHTML = '';
    recent.forEach((contact) => {
      const item = document.createElement('div');
      item.className = 'contact-item';

      const name = document.createElement('div');
      name.className = 'contact-name';
      name.textContent = contact.name || 'Unknown';
      item.appendChild(name);

      const subText = [contact.headline, contact.company].filter(Boolean).join(' · ');
      if (subText) {
        const sub = document.createElement('div');
        sub.className = 'contact-sub';
        sub.textContent = subText;
        item.appendChild(sub);
      }

      const time = document.createElement('div');
      time.className = 'contact-time';
      time.textContent = this.formatDate(contact.importedAt);
      item.appendChild(time);

      container.appendChild(item);
    });
  }

  formatDate(dateString) {
    if (!dateString) return 'Imported from LinkedIn';
    const date = new Date(dateString);
    const diffHours = Math.floor((Date.now() - date.getTime()) / 3600000);
    if (diffHours < 1) return 'Imported just now';
    if (diffHours < 24) return `Imported ${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `Imported ${diffDays}d ago`;
    return `Imported ${date.toLocaleDateString()}`;
  }

  // ----- Helpers -----

  setLoading(btn, loading, label) {
    if (!btn) return;
    btn.classList.toggle('is-loading', loading);
    btn.disabled = loading;
    const labelEl = btn.querySelector('.btn-label');
    if (labelEl && label) labelEl.textContent = label;
  }

  showError(message) {
    const el = document.getElementById('authError');
    if (!el) return;
    el.textContent = message;
    el.style.display = 'block';
  }

  clearError() {
    const el = document.getElementById('authError');
    if (el) el.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.popupManager = new PopupManager();
});
