# CareerVine Chrome Extension

Import LinkedIn profiles into your CareerVine CRM in one click. Open a profile, click the CareerVine button, review the AI-structured data, and save — name, experience, education, location, photo, suggested tags, and generated notes land on a contact without any copy-paste.

## Features

- **One-click profile import** — a floating button on LinkedIn profile pages opens a slide-out panel with the extracted profile
- **AI-structured data** — raw profile text is parsed server-side into clean fields (experience with dates, education, industry, student/professional status)
- **Already-in-CareerVine detection** — the panel tells you instantly when the person is already a contact, with an exact-LinkedIn-URL or name match
- **Review and edit before saving** — every field is editable in the panel; edits persist while you browse
- **Profile photo import** — the contact's photo is captured and stored with the contact
- **Auto-analyze mode** — optionally scrape each profile as you navigate to it (off by default)
- **2-hour profile cache** — revisiting a profile loads instantly without re-scraping

## Installation (development)

1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this `chrome-extension/` directory

The extension defaults to the development environment (`env/development.json` — localhost app + local Supabase). See SETUP.md for running the app locally.

## Production build

```bash
./build-prod.sh
```

Produces `careervine-extension-v<VERSION>.zip` for the Chrome Web Store: flips `ENV` to `production` in `background.js`, strips localhost host permissions from the manifest, rebuilds the panel app, and verifies no localhost references ship. Your working tree is restored to development mode afterward.

## Architecture

```
chrome-extension/
├── manifest.json                  # MV3 configuration
├── src/
│   ├── content/
│   │   ├── content.js             # Panel/FAB lifecycle, navigation detection, event bus
│   │   ├── linkedin-scraper.js    # Profile text extraction + cleaning
│   │   ├── identify-sections.js   # Section boundary detection (shared with tests)
│   │   ├── panel.css              # FAB + panel container styles
│   │   └── panel-app/panel.js     # Built React panel bundle (from panel-app/)
│   ├── popup/                     # Toolbar popup (sign in, recent imports)
│   ├── background/background.js   # Service worker: auth, token refresh, API calls
│   └── utils/                     # Popup helpers (API + storage wrappers)
├── panel-app/                     # React panel source (Vite; builds into src/content/panel-app/)
├── assets/icons/
└── env/                           # development.json / production.json
```

Auth and API calls live in the background service worker — tokens never leave it. The content script scrapes and talks to the panel over an in-page event bus; profile data is cached per-profile (keyed by LinkedIn slug) so multiple tabs never overwrite each other.

### API endpoints used

- `POST /api/extension/parse-profile` — AI parse of scraped profile text
- `POST /api/contacts/import` — create/update the contact
- `POST /api/contacts/check-duplicate` — "already in CareerVine" check

## Rebuilding the panel

The panel UI is a React app in `panel-app/`. After changing `panel-app/src/`:

```bash
cd panel-app && npm run build
```

This regenerates `src/content/panel-app/panel.js` — commit it together with the source change.

## Debugging

- Popup: right-click the popup → Inspect
- Content script + panel: DevTools console on the LinkedIn page
- Background worker: `chrome://extensions/` → "Service worker" → inspect

## Notes

- The scraper expects the LinkedIn UI in **English** (section headers like "Experience"/"Education" are matched literally).
- Scraping runs only for signed-in CareerVine users and only on demand (or with auto-analyze explicitly enabled).
