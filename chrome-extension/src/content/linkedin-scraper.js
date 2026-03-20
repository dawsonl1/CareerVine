/**
 * LinkedIn Profile Scraper - Based on scraping_rules.txt
 * Follows the exact process outlined in the scraping rules section
 */

class LinkedInScraper {
  async scrapeAndClean() {
    // Helper: instant scroll + wait for LinkedIn's lazy-load observers to fire.
    // 'smooth' scroll animates over hundreds of ms and doesn't guarantee the
    // viewport has actually moved when the call returns, so we use 'instant'
    // to ensure the position changes immediately, then wait for rendering.
    const scrollAndWait = async (top) => {
      window.scrollTo({ top, behavior: 'instant' });
      // Give intersection observers + React renders time to fire
      await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 400)));
    };

    const viewportH = window.innerHeight;

    // Phase 1: walk down the page in overlapping viewport-sized steps.
    // After each step, wait for lazy content. Keep going until we've been
    // at the bottom and the page height has been stable across 3 checks.
    let pos = 0;
    let stableCount = 0;
    let prevHeight = 0;
    const maxIterations = 40; // safety valve
    let iterations = 0;

    while (stableCount < 3 && iterations < maxIterations) {
      iterations++;
      const pageH = document.body.scrollHeight;

      // Scroll to next position
      pos += viewportH * 0.75;
      if (pos >= pageH) pos = pageH;
      await scrollAndWait(pos);

      // Check if we're at the bottom
      const newPageH = document.body.scrollHeight;
      if (pos >= newPageH - viewportH) {
        // We're near/at the bottom — has height stabilized?
        if (newPageH === prevHeight) {
          stableCount++;
        } else {
          stableCount = 0;
        }
        prevHeight = newPageH;

        // Hit absolute bottom to trigger any final lazy loads
        await scrollAndWait(newPageH);
      }
    }

    // Phase 2: scroll back to top so the user isn't left at the bottom
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // Wait for any final rendering after scroll-back
    await new Promise(r => setTimeout(r, 600 + Math.random() * 400));

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
}

window.LinkedInScraper = LinkedInScraper;
