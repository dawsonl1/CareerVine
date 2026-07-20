> **HISTORICAL - superseded, do not trust.** Written 2026-02-17 and never
> updated. It documents a naive fixed-count `window.scrollTo` loop; the shipped
> scraper uses `scrollToLoad()` in `chrome-extension/src/content/linkedin-scraper.js`,
> which detects the inner scroll container and loads sections lazily. This file
> also predates `chrome-extension/src/content/identify-sections.js` entirely.
>
> Read the scraper source instead. Kept for provenance only (CAR-157).

# LinkedIn Text Scraper - Logic Documentation

## Overview
This scraper extracts clean LinkedIn profile text by getting all rendered text from the page, then applying aggressive filtering to remove UI junk, activity posts, and unnecessary sections.

## Step 1: Text Extraction
```javascript
// Scroll to load all lazy-loaded content
for (let i = 0; i < 5; i++) {
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise(resolve => setTimeout(resolve, 300));
}

// Extract all text from main content area
const main = document.querySelector('main') || document.body;
let text = main.innerText || main.textContent || '';

// Split into lines and clean up
let lines = text.split('\n').map(line => line.trim()).filter(line => line);
```

## Step 2: Section Detection
The scraper identifies key LinkedIn profile sections to understand the structure:

```javascript
// Find sections (handles numbered lines like "13: About")
const aboutIndex = lines.findIndex(line => 
  line.toLowerCase() === 'about' || 
  line.toLowerCase().endsWith(': about') ||
  line.toLowerCase().includes('about') && line.length < 20
);

const activityIndex = lines.findIndex(line => 
  line.toLowerCase() === 'activity' || 
  line.toLowerCase().endsWith(': activity') ||
  line.toLowerCase().includes('activity') && line.length < 25
);

const experienceIndex = lines.findIndex(line => 
  line.toLowerCase() === 'experience' || 
  line.toLowerCase().endsWith(': experience') ||
  (line.toLowerCase().includes('experience') && line.length < 25)
);

const skillsIndex = lines.findIndex(line => 
  line.toLowerCase() === 'skills' || 
  line.toLowerCase().endsWith(': skills') ||
  (line.toLowerCase().includes('skills') && line.length < 20)
);
```

## Step 3: Content Selection Strategy
The scraper only keeps specific sections and skips everything else:

### What Gets Included:
1. **Name** - First line (with line number removed)
2. **Header Info** - Location, company, school (before About section)
3. **About Section** - Clean About content only
4. **Experience Section** - All jobs and descriptions
5. **Education Section** - School and degree information

### What Gets Skipped:
- **Activity Section** - Completely removed (all posts, reactions, comments)
- **Skills Section** - Everything after Skills is removed
- **Recommendations** - Not included
- **Interests** - Not included
- **People Suggestions** - All job titles from "People you may know"

## Step 4: Aggressive Filtering Logic

### Name Processing
```javascript
// Add name (first line, remove line number if present)
let nameLine = lines[0];
nameLine = nameLine.replace(/^\d+:\s*/, ''); // Remove "1: " prefix
```

### About Section Cleaning
```javascript
const cleanAbout = aboutContent.filter(line => 
  line.length > 20 &&                    // Only substantial lines
  !line.includes('… more') &&            // Remove "… more" links
  !line.includes('Contact info') &&      // Remove UI elements
  !line.includes('followers') &&         // Remove social stats
  !line.includes('connections')          // Remove connection counts
);
```

### Experience Section Limits
```javascript
// Stop at first Skills section, or limit to 30 lines if no Skills found
if (experienceIndex !== -1 && skillsIndex !== -1 && skillsIndex > experienceIndex) {
  let experienceContent = lines.slice(experienceIndex, skillsIndex);
} else {
  let experienceContent = lines.slice(experienceIndex, experienceIndex + 30);
}
```

## Step 5: Junk Removal Filters

### UI and Navigation Elements
```javascript
// Remove all LinkedIn navigation and UI elements
if (/^(home|network|jobs|messaging|notifications|me|business|learning|posts|comments|images|contact info|message|connect|follow|like|comment|repost|send|endorse)$/i.test(line)) return false;
```

### Social Statistics and Interactions
```javascript
// Remove follower counts, connection stats, reaction counts
if (/^\d+ (followers|connections|following|reactions|comments|endorsements)$/i.test(line)) return false;
if (/^(show all|show more|see more|more)$/i.test(line)) return false;

// Remove connection text
if (/\d+ connections$/i.test(line)) return false;
if (/^\w+ and \d+ other mutual connections$/i.test(line)) return false;
```

### Time Indicators
```javascript
// Remove time stamps like "5mo • Edited •"
if (/^\d+[hdwmy] (ago|•)$/i.test(line)) return false;
if (/^• \d+(st|nd|rd|th)$/i.test(line)) return false;
if (/^· \d+(st|nd|rd|th)$/i.test(line)) return false;
if (/^(edited)$/i.test(line)) return false;
```

### Activity Post Content
```javascript
// Remove all activity post starters and content
if (/^(couldn't be more|stoked to share|big day|excited to announce|looking forward|special thanks|insanely excited|we're thrilled|we continue|today,|from|if you|whether it's|turn on|learn more|read full|the ceiling of|exceptional startups)/i.test(line)) return false;
```

### Hashtags and Symbols
```javascript
// Remove hashtags, checkmarks, bullet points
if (/^#\w+/i.test(line)) return false;
if (/^(✔|✅|•|·)/.test(line)) return false;
```

### Company Names with Follower Counts
```javascript
// Remove "Company Name 1234 followers"
if (/\d+ followers$/i.test(line)) return false;
```

### Job Titles from People Suggestions
```javascript
// Remove job titles from "People you may know" section
if (/^[A-Z][a-z]+ [A-Z][a-z]+ (at|@) [A-Z]/i.test(line)) return false;
if (/^[A-Z][a-z]+ [A-Z][a-z]+ \| [A-Z]/i.test(line)) return false;
if (/^[A-Z][\w\s]*\| [A-Z]/i.test(line)) return false;
if (/^following$/i.test(line)) return false;
```

### Footer and Legal Junk
```javascript
// Remove LinkedIn footer links and legal text
if (/^(about|accessibility|careers|privacy|terms|linkedin corporation|questions|visit our|manage your|recommendation|learn more|select language|advertising|mobile|small business|safety center|talent solutions|community guidelines)/i.test(line)) return false;

// Remove specific footer companies
if (/^(leland|byu marriott mba|christian|professional training|coaching)$/i.test(line)) return false;
```

### All Languages
```javascript
// Remove every language LinkedIn supports (English and native script)
if (/^(arabic|bangla|czech|danish|german|greek|english|spanish|persian|finnish|french|hindi|hungarian|indonesian|italian|hebrew|japanese|korean|marathi|malay|dutch|norwegian|punjabi|polish|portuguese|romanian|russian|swedish|telugu|thai|tagalog|turkish|ukrainian|vietnamese|chinese|čeština|dansk|deutsch|ελληνικά|español|suomi|français|magyar|bahasa|italiano|עברית|日本語|한국어|मराठी|nederlands|norsk|polski|português|română|русский|svenska|తెలుగు|ภาษาไทย|tagalog|türkçe|українська|tiếng việt|简体中文|正體中文)/i.test(line)) return false;
```

### Suggestions and Profiles
```javascript
// Remove "People you may know" and other suggestion sections
if (/^(more profiles for you|people you may know|you might like|pages for you|causes|companies|groups|newsletters|schools|interests|top voices|explore premium|from.*school)/i.test(line)) return false;
```

### Special Character Patterns
```javascript
// Remove lines with lots of special characters (people suggestions)
if (line.includes('|') && line.length > 30) return false;
if (line.includes('@') && line.includes('|')) return false;

// Remove very short lines and symbols
if (line.length < 3) return false;
if (/^[\d\s,·•-]+$/.test(line)) return false;
```

### Just Names (from Activity)
```javascript
// Remove standalone names that are likely from activity posts
if (/^[A-Z][a-z]+ [A-Z][a-z]+$/i.test(line) && line.length < 25) return false;
```

### Punctuation-Heavy Lines
```javascript
// Remove lines that are mostly punctuation
const nonWordChars = line.replace(/\w/g, '').length;
if (nonWordChars > line.length * 0.4) return false;
```

### URLs and Links
```javascript
// Remove URLs and external links
if (/^https?:\/\//i.test(line)) return false;
if (/^www\./i.test(line)) return false;
if (/^link to/i.test(line)) return false;

// Remove "… more" and similar
if (/^… more$/i.test(line)) return false;
```

## Step 6: Final Safety Check
```javascript
// Final safety check: remove everything after Skills section
const skillsInResult = result.findIndex(line => 
  line.toLowerCase() === 'skills' || 
  line.toLowerCase().endsWith(': skills') ||
  (line.toLowerCase().includes('skills') && line.length < 20)
);

if (skillsInResult !== -1) {
  result = result.slice(0, skillsInResult);
}
```

## Step 7: Name Protection
```javascript
// Never filter out the first line (name)
return lines.filter((line, index) => {
  if (index === 0) return true; // Always keep the name
  // ... all other filters
});
```

## Final Output Structure
The final cleaned output contains only:
1. **Name** (always preserved)
2. **Location/Company/School** (header info)
3. **About** (substantial content only)
4. **Experience** (jobs and descriptions)
5. **Education** (school and degree info)

Everything else is aggressively filtered out to provide clean, structured data for AI parsing.
