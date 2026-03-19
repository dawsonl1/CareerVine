/**
 * CareerVine Extension Popup Logic
 * Handles authentication and user interface
 */

class PopupManager {
  constructor() {
    this.api = new CareerVineAPI();
    this.storage = new StorageHelper();
    this.currentTab = 'import';
    
    this.init();
  }

  async init() {
    // Set up event listeners
    this.setupEventListeners();
    
    // Check authentication status
    await this.checkAuthStatus();
    
    // Load recent contacts
    await this.loadRecentContacts();
    
    // Get current tab info
    await this.getCurrentTabInfo();
  }

  setupEventListeners() {
    // Authentication form
    const authForm = document.getElementById('authForm');
    if (authForm) {
      authForm.addEventListener('submit', (e) => this.handleSignIn(e));
    }

    // Clear status message when user starts typing
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    if (emailInput) {
      emailInput.addEventListener('input', () => this.clearAuthStatus());
    }
    if (passwordInput) {
      passwordInput.addEventListener('input', () => this.clearAuthStatus());
    }

    // Sign up link
    const signupLink = document.getElementById('signupLink');
    if (signupLink) {
      signupLink.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: 'https://careervine.app/auth' });
      });
    }

    // Sign out button
    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', () => this.handleSignOut());
    }

    // Tab navigation
    const tabBtns = document.querySelectorAll('.nav-tab');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
  }

  async checkAuthStatus() {
    try {
      const authStatus = await this.api.checkAuth();
      
      if (authStatus.authenticated) {
        this.showMainSection(authStatus.user);
      } else {
        this.showAuthSection();
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      this.showAuthSection();
    }
  }

  showAuthSection() {
    document.getElementById('authSection').style.display = 'block';
    document.getElementById('mainSection').style.display = 'none';
    document.getElementById('loadingSection').style.display = 'none';
    document.getElementById('signOutBtn').style.display = 'none';
  }

  showMainSection(user) {
    document.getElementById('authSection').style.display = 'none';
    document.getElementById('mainSection').style.display = 'block';
    document.getElementById('loadingSection').style.display = 'none';
    document.getElementById('signOutBtn').style.display = 'block';
    
    if (user) {
      document.getElementById('userEmail').textContent = user.email || 'Signed in';
    }
  }

  showLoadingSection() {
    document.getElementById('authSection').style.display = 'none';
    document.getElementById('mainSection').style.display = 'none';
    document.getElementById('loadingSection').style.display = 'flex';
  }

  async handleSignIn(e) {
    e.preventDefault();
    
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const signInBtn = document.getElementById('signInBtn');
    
    // Show loading state
    signInBtn.disabled = true;
    signInBtn.textContent = 'Signing in...';
    
    try {
      const session = await this.api.authenticate(email, password);
      this.showStatusMessage('Signed in successfully!', 'success');
      
      // Switch to main section after a short delay
      setTimeout(async () => {
        await this.checkAuthStatus();
      }, 1000);
      
    } catch (error) {
      this.showStatusMessage(`Sign in failed: ${error.message}`, 'error');
    } finally {
      signInBtn.disabled = false;
      signInBtn.textContent = 'Sign In';
    }
  }

  async handleSignOut() {
    try {
      await this.api.logout();
      this.showAuthSection();
      this.clearForm();
    } catch (error) {
      console.error('Sign out failed:', error);
      this.showStatusMessage('Sign out failed', 'error');
    }
  }

  clearForm() {
    document.getElementById('email').value = '';
    document.getElementById('password').value = '';
    this.clearAuthStatus();
  }

  clearAuthStatus() {
    const authStatus = document.getElementById('authStatus');
    if (authStatus) {
      authStatus.style.display = 'none';
    }
  }

  switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.toggle('active', content.id === `${tabName}Tab`);
    });
    
    this.currentTab = tabName;
  }

  async loadRecentContacts() {
    try {
      const recentContacts = await this.storage.getRecentContacts();
      const container = document.getElementById('recentContacts');
      
      if (recentContacts.length === 0) {
        container.innerHTML = '<p class="empty-state">No contacts imported yet</p>';
        return;
      }
      
      container.innerHTML = recentContacts.map(contact => `
        <div class="contact-item">
          <div class="contact-name">${contact.name || 'Unknown'}</div>
          <div class="contact-details">
            ${contact.headline ? `<div>${contact.headline}</div>` : ''}
            ${contact.company ? `<div>${contact.company}</div>` : ''}
            ${contact.school ? `<div>${contact.school}</div>` : ''}
          </div>
          <div class="contact-meta">
            <span>Imported from LinkedIn</span>
            <span>${this.formatDate(contact.importedAt)}</span>
          </div>
        </div>
      `).join('');
      
    } catch (error) {
      console.error('Failed to load recent contacts:', error);
    }
  }

  async getCurrentTabInfo() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const pageInfo = document.getElementById('currentPageInfo');
      
      if (tab.url.includes('linkedin.com/in/')) {
        pageInfo.textContent = 'LinkedIn Profile Page';
        pageInfo.style.color = '#2d6a30';
      } else if (tab.url.includes('linkedin.com/company/')) {
        pageInfo.textContent = 'LinkedIn Company Page';
        pageInfo.style.color = '#2d6a30';
      } else {
        pageInfo.textContent = 'Not a LinkedIn page';
        pageInfo.style.color = '#666';
      }
      
    } catch (error) {
      console.error('Failed to get current tab info:', error);
    }
  }

  formatDate(dateString) {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    
    if (diffHours < 1) {
      return 'Just now';
    } else if (diffHours < 24) {
      return `${diffHours}h ago`;
    } else {
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays < 7) {
        return `${diffDays}d ago`;
      } else {
        return date.toLocaleDateString();
      }
    }
  }

  showStatusMessage(message, type = 'info') {
    // Use the dedicated auth status container if we're in auth section
    const authStatus = document.getElementById('authStatus');
    const authSection = document.getElementById('authSection');
    
    if (authStatus && authSection.style.display !== 'none') {
      // Show auth-specific status message
      authStatus.className = `status-message ${type}`;
      authStatus.querySelector('.status-text').textContent = message;
      authStatus.style.display = 'block';
      
      // Auto-hide after 5 seconds
      setTimeout(() => {
        authStatus.style.display = 'none';
      }, 5000);
    } else {
      // For other sections, create dynamic status message
      const existing = document.querySelector('.status-message:not(#authStatus)');
      if (existing) {
        existing.remove();
      }
      
      const statusDiv = document.createElement('div');
      statusDiv.className = `status-message ${type}`;
      statusDiv.textContent = message;
      
      const currentSection = document.querySelector('.popup-content > section[style*="block"], .popup-content > section:not([style*="none"])');
      if (currentSection) {
        currentSection.insertBefore(statusDiv, currentSection.firstChild);
      }
      
      setTimeout(() => {
        if (statusDiv.parentNode) {
          statusDiv.remove();
        }
      }, 5000);
    }
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.popupManager = new PopupManager();
});

// Handle messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'contactImported') {
    // Refresh recent contacts when a contact is imported
    const popupManager = window.popupManager;
    if (popupManager) {
      popupManager.loadRecentContacts();
    }
  }
});
