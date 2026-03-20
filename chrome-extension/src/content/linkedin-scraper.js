/**
 * LinkedIn Profile Scraper - Based on scraping_rules.txt
 * Follows the exact process outlined in the scraping rules section
 */

class LinkedInScraper {
  async scrapeAndClean() {
    // Scroll progressively through the page to trigger LinkedIn's
    // lazy-loading for each section (Experience, Education, etc.).
    // A single jump to scrollHeight misses sections that haven't
    // entered the viewport yet.
    const scrollStep = window.innerHeight * 0.7;
    let currentPos = 0;
    let lastHeight = document.body.scrollHeight;

    while (currentPos < document.body.scrollHeight) {
      currentPos += scrollStep;
      window.scrollTo({ top: currentPos, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 400));

      // If the page grew (new content loaded), keep going
      if (document.body.scrollHeight > lastHeight) {
        lastHeight = document.body.scrollHeight;
      }
    }

    // Brief pause at the bottom for any final lazy-loaded content
    await new Promise(r => setTimeout(r, 600));

    // Scroll back to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
   * Returns a 400x400 LinkedIn CDN URL, or null if no real photo found.
   */
  extractProfilePhotoUrl() {
    const main = document.querySelector('main') || document.body;

    // Strategy 1: 400x400 image (best quality, already correct size)
    const img400 = main.querySelector('img[src*="profile-displayphoto-shrink_400_400"]')
      || main.querySelector('img[src*="profile-displayphoto-scale_400_400"]');
    if (img400) {
      const src = img400.getAttribute('src');
      if (src && src.includes('media.licdn.com/dms/image')) return src;
    }

    // Strategy 2: 100x100 shrink — rewrite to 400x400
    const imgShrink100 = main.querySelector('img[src*="profile-displayphoto-shrink_100_100"]');
    if (imgShrink100) {
      const src = imgShrink100.getAttribute('src');
      if (src && src.includes('media.licdn.com/dms/image')) {
        return src.replace(/profile-displayphoto-shrink_100_100/g, 'profile-displayphoto-shrink_400_400');
      }
    }

    // Strategy 3: 100x100 scale — rewrite to 400x400
    const imgScale100 = main.querySelector('img[src*="profile-displayphoto-scale_100_100"]');
    if (imgScale100) {
      const src = imgScale100.getAttribute('src');
      if (src && src.includes('media.licdn.com/dms/image')) {
        return src.replace(/profile-displayphoto-scale_100_100/g, 'profile-displayphoto-scale_400_400');
      }
    }

    // No real photo found (ghost avatar or no photo element)
    return null;
  }
}

window.LinkedInScraper = LinkedInScraper;
