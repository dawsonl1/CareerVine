/**
 * LinkedIn Profile Scraper - Based on scraping_rules.txt
 * Follows the exact process outlined in the scraping rules section
 */

class LinkedInScraper {
  /**
   * Wait for LinkedIn to inject key profile sections into the DOM.
   * LinkedIn is an SPA — after navigation, the header renders first
   * and Experience/Education sections arrive via async API calls.
   * Without this wait, the scraper may scroll before sections exist.
   */
  async waitForSections() {
    const MAX_WAIT = 5000;   // Give up after 5 seconds
    const POLL_INTERVAL = 200;
    let elapsed = 0;

    while (elapsed < MAX_WAIT) {
      const mainText = (document.querySelector('main') || document.body).innerText || '';
      // Check if at least Experience OR Education section header is present
      if (mainText.includes('Experience') || mainText.includes('Education')) {
        // Found a section — give LinkedIn a brief moment to finish injecting siblings
        await new Promise(r => setTimeout(r, 300));
        return;
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      elapsed += POLL_INTERVAL;
    }
    // Timed out — proceed anyway with whatever content is available
  }

  async scrapeAndClean() {
    // Wait for LinkedIn to finish rendering profile sections into the DOM
    await this.waitForSections();

    // Progressively scroll through the page to trigger LinkedIn's lazy-loading
    // for each section (Experience, Education, etc.). Use instant jumps, not
    // smooth: smooth scrolling lags behind the loop, so the loop can reach
    // scrollHeight and exit before the animation actually renders the lower
    // sections — which left later experiences and the education section out of
    // the captured text on profiles with a long activity feed (CAR-95).
    const scrollStep = Math.max(400, Math.floor(window.innerHeight * 0.6));
    let currentPos = 0;
    const MAX_STEPS = 80; // safety cap so an ever-growing feed can't hang the scrape

    for (let step = 0; step < MAX_STEPS; step++) {
      window.scrollTo({ top: currentPos, behavior: 'instant' });
      await new Promise(r => setTimeout(r, 350));
      if (currentPos >= document.body.scrollHeight) break; // reached the bottom
      currentPos += scrollStep;
    }

    // Settle at the very bottom for any final lazy-loaded content, then return
    // to the top so nothing downstream depends on scroll position.
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    await new Promise(r => setTimeout(r, 800));
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise(r => setTimeout(r, 300));

    // Extract all text from main content area
    const main = document.querySelector('main') || document.body;
    let text = main.innerText || main.textContent || '';

    // Separate it into an array by \n character (keep empty items - they're significant)
    let lines = text.split('\n');

    // The first word in the first item is the person's first name
    const firstName = lines[0] ? lines[0].split(' ')[0] : '';

    // Find the Skills section
    let skillsIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === 'Skills' && 
          i > 0 && lines[i-1].trim() === '' && 
          i < lines.length - 1 && lines[i+1].trim() === '') {
        skillsIndex = i;
        break;
      }
    }

    // If no Skills section found, look for Recommendations section
    let cutoffIndex = -1;
    if (skillsIndex !== -1) {
      cutoffIndex = skillsIndex;
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === 'Recommendations' && 
            i < lines.length - 1 && 
            lines[i+1].includes(`Recommend ${firstName}`)) {
          cutoffIndex = i;
          break;
        }
      }
    }

    // Get rid of everything up to and including the cutoff section
    let relevantLines = cutoffIndex !== -1 ? lines.slice(0, cutoffIndex) : lines;

    // Determine what sections are present and where each starts and ends
    let sections = this.identifySections(relevantLines);

    // Process sections according to rules
    let cleanedLines = [];

    // Keep the entire first section (header info)
    if (sections.header) {
      cleanedLines = cleanedLines.concat(relevantLines.slice(sections.header.start, sections.header.end));
    }

    // Keep the About section (don't try to parse it)
    if (sections.about) {
      cleanedLines = cleanedLines.concat(relevantLines.slice(sections.about.start, sections.about.end));
    }

    // Keep the experience section (don't try to parse it)
    if (sections.experience) {
      cleanedLines = cleanedLines.concat(relevantLines.slice(sections.experience.start, sections.experience.end));
    }

    // Keep the education section (don't try to parse it)
    if (sections.education) {
      cleanedLines = cleanedLines.concat(relevantLines.slice(sections.education.start, sections.education.end));
    }

    // Apply additional filtering rules to the first section
    if (sections.header) {
      let headerLines = cleanedLines.slice(0, sections.header.end);
      headerLines = headerLines.filter(line => {
        const trimmed = line.trim();
        
        // Remove pronouns (case insensitive)
        if (/^(he\/him|she\/her|they\/them)$/i.test(trimmed)) return false;
        
        // Remove bullet points
        if (trimmed.startsWith('·')) return false;
        
        // Remove "Contact info"
        if (trimmed === 'Contact info') return false;
        
        // Remove follower counts
        if (/^\d[,\d]* followers$/i.test(trimmed)) return false;
        
        // Remove connection counts
        if (/^\d[,\d]*\+? connections$/i.test(trimmed)) return false;
        
        // Remove mutual connections text
        if (/mutual connections?$/.test(trimmed)) return false;
        
        // Remove just "Message"
        if (trimmed === 'Message') return false;
        
        return true;
      });
      
      // Replace the header section with filtered version
      cleanedLines = headerLines.concat(cleanedLines.slice(sections.header.end));
    }

    // At the end of processing, get rid of all lines that are "… more"
    cleanedLines = cleanedLines.filter(line => line.trim() !== '… more');

    // If there is an item that is only "Licenses & certifications", get rid of it and everything after it
    const licensesIndex = cleanedLines.findIndex(line => line.trim() === 'Licenses & certifications');
    if (licensesIndex !== -1) {
      cleanedLines = cleanedLines.slice(0, licensesIndex);
    }

    // If there is a line that starts with "·" in the first 5 items, get rid of it as well
    if (cleanedLines.length >= 5) {
      const firstFive = cleanedLines.slice(0, 5);
      const bulletIndex = firstFive.findIndex(line => line.trim().startsWith('·'));
      if (bulletIndex !== -1) {
        // Remove the bullet line
        cleanedLines.splice(bulletIndex, 1);
      }
    }

    // Remove "Profile enhanced with Premium", "Book an appointment", and "Show all" lines
    cleanedLines = cleanedLines.filter(line => {
      const trimmed = line.trim();
      return trimmed !== 'Profile enhanced with Premium' && 
             trimmed !== 'Book an appointment' && 
             trimmed !== 'Show all';
    });

    // Return the cleaned text (no longer downloading)
    return cleanedLines.join('\n');
  }

  identifySections(lines) {
    // Delegate to the shared pure function (loaded via identify-sections.js)
    return window._identifySections(lines);
  }

  /**
   * Extract the viewed profile's photo URL from the DOM.
   *
   * A profile page contains many profile-photo <img>s — the person's hero
   * avatar, but also "People you may know", "More profiles for you", and their
   * own reshared-post avatars. The old code grabbed the first CDN match of two
   * hardcoded sizes anywhere in <main>, so it could lock onto someone else's
   * avatar, and it missed hero photos served at other sizes (e.g. 200x200),
   * returning null (CAR-95). This scopes to the intro card first, then falls
   * back to an alt-text identity match, and accepts any size (normalized to
   * 400x400). Returns a LinkedIn CDN URL, or null if no real photo is found.
   */
  extractProfilePhotoUrl() {
    const main = document.querySelector('main') || document.body;

    const isProfilePhoto = (img) => {
      const src = img.getAttribute('src') || '';
      return src.includes('profile-displayphoto') && src.includes('media.licdn.com/dms/image');
    };
    // LinkedIn's signed CDN URLs are keyed on the media id, not the rendered
    // size, so upsizing the size token to 400x400 keeps the signature valid.
    const to400 = (src) =>
      src.replace(/profile-displayphoto-(?:shrink|scale)_\d+_\d+/g, 'profile-displayphoto-shrink_400_400');

    // 1. Scope to the intro/top card — the <section> that contains the name
    //    heading. Its photo is unambiguously the viewed person's.
    const nameEl = main.querySelector('h1');
    const topCard = nameEl ? nameEl.closest('section') : null;
    if (topCard) {
      const heroImg = Array.from(topCard.querySelectorAll('img')).find(isProfilePhoto);
      if (heroImg) return to400(heroImg.getAttribute('src'));
    }

    // 2. Fallback: among every profile photo on the page, pick the one whose
    //    alt text matches the viewed person (LinkedIn sets the hero avatar's
    //    alt to their full name) — avoids other people's suggested avatars.
    const photos = Array.from(main.querySelectorAll('img')).filter(isProfilePhoto);
    const personName = (nameEl?.innerText || '').trim().toLowerCase();
    if (personName) {
      const match = photos.find((img) => {
        const alt = (img.getAttribute('alt') || '').trim().toLowerCase();
        return alt && (alt.includes(personName) || personName.includes(alt));
      });
      if (match) return to400(match.getAttribute('src'));
      // Name known but no photo matched them → treat as no photo rather than
      // risk returning a stranger's avatar.
      return null;
    }

    // 3. No name to match on: best-effort first profile photo in DOM order
    //    (the top card renders first).
    return photos.length ? to400(photos[0].getAttribute('src')) : null;
  }
}

window.LinkedInScraper = LinkedInScraper;
