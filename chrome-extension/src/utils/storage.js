/**
 * Storage Helper
 * Wraps chrome.storage.local for popup data persistence
 */

class StorageHelper {
  async getRecentContacts() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['recentContacts'], (result) => {
        resolve(result.recentContacts || []);
      });
    });
  }
}

window.StorageHelper = StorageHelper;
