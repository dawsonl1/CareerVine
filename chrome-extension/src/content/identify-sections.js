/**
 * Identify LinkedIn profile section boundaries from an array of text lines.
 * Pure function — no DOM access, no side effects.
 *
 * Shared between the scraper (content script) and the test suite.
 * When loaded as a plain script (content script context), it attaches to
 * `window._identifySections`.  When imported as an ES module (tests), it
 * is available as the default export.
 */

function identifySections(lines) {
  let sections = {
    header: { start: 0, end: 0 },
    highlights: null,
    about: null,
    services: null,
    featured: null,
    activity: null,
    experience: null,
    education: null
  };

  let currentSection = 'header';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Look for section headers
    if (line === 'Highlights') {
      sections.header.end = i;
      sections.highlights = { start: i, end: i };
      currentSection = 'highlights';
    } else if (line === 'About') {
      if (sections.highlights) {
        sections.highlights.end = i;
      } else {
        sections.header.end = i;
      }
      sections.about = { start: i, end: i };
      currentSection = 'about';
    } else if (line === 'Services') {
      if (sections.about) {
        sections.about.end = i;
      } else if (sections.highlights) {
        sections.highlights.end = i;
      } else {
        sections.header.end = i;
      }
      sections.services = { start: i, end: i };
      currentSection = 'services';
    } else if (line === 'Featured') {
      if (sections.services) {
        sections.services.end = i;
      } else if (sections.about) {
        sections.about.end = i;
      } else if (sections.highlights) {
        sections.highlights.end = i;
      } else {
        sections.header.end = i;
      }
      sections.featured = { start: i, end: i };
      currentSection = 'featured';
    } else if (line === 'Activity') {
      if (sections.featured) {
        sections.featured.end = i;
      } else if (sections.services) {
        sections.services.end = i;
      } else if (sections.about) {
        sections.about.end = i;
      } else if (sections.highlights) {
        sections.highlights.end = i;
      } else {
        sections.header.end = i;
      }
      sections.activity = { start: i, end: i };
      currentSection = 'activity';
    } else if (line === 'Experience') {
      if (sections.activity) {
        sections.activity.end = i;
      } else if (sections.featured) {
        sections.featured.end = i;
      } else if (sections.services) {
        sections.services.end = i;
      } else if (sections.about) {
        sections.about.end = i;
      } else if (sections.highlights) {
        sections.highlights.end = i;
      } else {
        sections.header.end = i;
      }
      sections.experience = { start: i, end: i };
      currentSection = 'experience';
    } else if (line === 'Education') {
      if (sections.experience) {
        sections.experience.end = i;
      } else if (sections.activity) {
        sections.activity.end = i;
      } else if (sections.featured) {
        sections.featured.end = i;
      } else if (sections.services) {
        sections.services.end = i;
      } else if (sections.about) {
        sections.about.end = i;
      } else if (sections.highlights) {
        sections.highlights.end = i;
      } else {
        sections.header.end = i;
      }
      sections.education = { start: i, end: i };
      currentSection = 'education';
    } else if (line === 'Skills' || line === 'Recommendations') {
      // End the current section
      if (currentSection === 'education' && sections.education) {
        sections.education.end = i;
      } else if (currentSection === 'experience' && sections.experience) {
        sections.experience.end = i;
      } else if (currentSection === 'activity' && sections.activity) {
        sections.activity.end = i;
      } else if (currentSection === 'featured' && sections.featured) {
        sections.featured.end = i;
      } else if (currentSection === 'services' && sections.services) {
        sections.services.end = i;
      } else if (currentSection === 'about' && sections.about) {
        sections.about.end = i;
      } else if (currentSection === 'highlights' && sections.highlights) {
        sections.highlights.end = i;
      } else {
        sections.header.end = i;
      }
      break;
    }
  }

  // If we never found a proper end for the last section, set it to the end of lines
  if (sections.education && sections.education.end === sections.education.start) {
    sections.education.end = lines.length;
  } else if (sections.experience && sections.experience.end === sections.experience.start) {
    sections.experience.end = lines.length;
  } else if (sections.activity && sections.activity.end === sections.activity.start) {
    sections.activity.end = lines.length;
  } else if (sections.featured && sections.featured.end === sections.featured.start) {
    sections.featured.end = lines.length;
  } else if (sections.services && sections.services.end === sections.services.start) {
    sections.services.end = lines.length;
  } else if (sections.about && sections.about.end === sections.about.start) {
    sections.about.end = lines.length;
  } else if (sections.highlights && sections.highlights.end === sections.highlights.start) {
    sections.highlights.end = lines.length;
  } else if (sections.header.end === 0) {
    sections.header.end = lines.length;
  }

  return sections;
}

// Content-script global (for scraper) — in test/module contexts this is harmless
try { window._identifySections = identifySections; } catch (_) { /* not in browser */ }

// ES module export (for tests via vitest)
export { identifySections };
