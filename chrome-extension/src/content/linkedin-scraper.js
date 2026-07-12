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
    const MAX_WAIT = 6000;   // Give up after 6 seconds
    const POLL_INTERVAL = 200;
    let elapsed = 0;

    while (elapsed < MAX_WAIT) {
      const mainText = (document.querySelector('main') || document.body).innerText || '';
      // The top card + About render first; Experience/Education only load once
      // scrolled into view (newer layout), so wait for substantial content
      // rather than a specific section header (CAR-95).
      if (mainText.trim().length > 300) {
        // Give LinkedIn a brief moment to finish the initial render
        await new Promise(r => setTimeout(r, 300));
        return;
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      elapsed += POLL_INTERVAL;
    }
    // Timed out — proceed anyway with whatever content is available
  }

  /**
   * The element that actually scrolls the profile. LinkedIn's newer layout
   * puts the page in an inner scroll container (the <main> element, with
   * body overflow:hidden) rather than scrolling the window; older layouts
   * scroll the window. Detect whichever applies so lazy content loads (CAR-95).
   */
  getScroller() {
    const main = document.querySelector('main');
    if (main && main.scrollHeight > main.clientHeight + 200) return main;
    return document.scrollingElement || document.documentElement;
  }

  /**
   * Progressively scroll the profile to trigger LinkedIn's lazy-loading of
   * every section. Uses instant jumps (smooth scrolling lags the loop and
   * exits before content renders) and scrolls the detected container, which
   * is what makes Experience/Education actually load in the newer layout.
   */
  async scrollToLoad() {
    const scroller = this.getScroller();
    const usesWindow =
      scroller === document.scrollingElement ||
      scroller === document.documentElement ||
      scroller === document.body;
    const jumpTo = (top) =>
      usesWindow
        ? window.scrollTo({ top, behavior: 'instant' })
        : scroller.scrollTo({ top, behavior: 'instant' });

    const viewport = scroller.clientHeight || window.innerHeight || 800;
    const scrollStep = Math.max(400, Math.floor(viewport * 0.6));
    const MAX_STEPS = 80; // safety cap so an ever-growing feed can't hang the scrape

    let pos = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      jumpTo(pos);
      await new Promise(r => setTimeout(r, 350));
      if (pos >= scroller.scrollHeight) break; // reached the bottom
      pos += scrollStep;
    }

    // Settle at the very bottom for any final lazy-loaded content, then return
    // to the top so nothing downstream depends on scroll position.
    jumpTo(scroller.scrollHeight);
    await new Promise(r => setTimeout(r, 800));
    jumpTo(0);
    await new Promise(r => setTimeout(r, 300));
  }

  async scrapeAndClean() {
    // Wait for LinkedIn to finish the initial render
    await this.waitForSections();

    // Scroll the profile (via its real scroll container) to lazy-load every
    // section before reading the text.
    await this.scrollToLoad();

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
   * A profile page contains many profile-photo <img>s: the person's hero
   * avatar, but also "People you may know", "More profiles for you", and their
   * own reshared-post avatars. The old code grabbed the first CDN match of two
   * hardcoded sizes anywhere in <main>, so it could lock onto someone else's
   * avatar, and it missed hero photos served at other sizes — returning the
   * wrong photo or none (CAR-95).
   *
   * The hero avatar renders far larger (~120-160px) than the feed/suggestion
   * avatars (~48px), so we pick the largest-rendered profile photo. This is
   * layout-agnostic (works on both the old and the newer inner-scroll layout,
   * neither of which reliably has an <h1> or alt text to key off). Returns the
   * photo's own CDN URL unchanged (it's a valid signed URL; upsizing the size
   * token yields a broken URL), or null if there's no real photo (ghost).
   */
  extractProfilePhotoUrl() {
    const photos = Array.from(document.querySelectorAll('img')).filter((img) => {
      const src = img.getAttribute('src') || '';
      return src.includes('profile-displayphoto') && src.includes('licdn');
    });

    let hero = null;
    let maxWidth = 0;
    for (const img of photos) {
      const width = img.getBoundingClientRect().width || img.naturalWidth || 0;
      if (width > maxWidth) {
        maxWidth = width;
        hero = img;
      }
    }

    // Even the biggest is avatar-sized → the person has no photo (ghost avatar).
    if (!hero || maxWidth < 64) return null;
    return hero.getAttribute('src');
  }
}

window.LinkedInScraper = LinkedInScraper;
