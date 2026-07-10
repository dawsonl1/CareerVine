/**
 * CareerVine API Helper
 * Wraps chrome.runtime.sendMessage for popup communication with background script
 */

class CareerVineAPI {
  /**
   * Authenticate user with email and password
   */
  async authenticate(email, password) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'authenticate', credentials: { email, password } },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response?.error) {
            reject(new Error(response.error));
          } else if (response?.success) {
            resolve(response.session);
          } else {
            reject(new Error('Authentication failed'));
          }
        }
      );
    });
  }

  /**
   * Check if user is authenticated
   */
  async checkAuth() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'checkAuth' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve({
            authenticated: response?.authenticated || false,
            user: response?.user || null
          });
        }
      });
    });
  }

  /**
   * Log out user
   */
  async logout() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'logout' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

}

// Make available globally
window.CareerVineAPI = CareerVineAPI;
