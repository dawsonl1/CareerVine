# Chrome Extension Setup

## Quick start (local development)

1. **Start the CareerVine app**:
   ```bash
   cd careervine
   npm run dev
   ```

2. **Start Supabase** (from the repo root):
   ```bash
   supabase start
   ```

3. **Load the extension**:
   - Open Chrome → `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `chrome-extension/` directory

The extension defaults to `env/development.json` (app on `localhost:3000`, Supabase on `127.0.0.1:54321`). For a production build, run `./build-prod.sh` — see README.md.

## Using it

1. **Sign in**: click the CareerVine toolbar icon and sign in with your CareerVine credentials (or create an account / reset your password via the links).
2. **Navigate** to a LinkedIn profile page — the CareerVine button appears on the right.
3. **Analyze**: open the panel and click "Analyze Profile" (or enable auto-analyze).
4. **Review & save**: edit anything that needs fixing, then "Save Contact".

## Troubleshooting

- **Extension not loading** — check `manifest.json` syntax, then reload from `chrome://extensions/`.
- **Button not appearing** — it only shows on `linkedin.com/in/...` profile pages; refresh the tab after (re)loading the extension.
- **Authentication errors** — ensure the CareerVine app is running on `localhost:3000` and local Supabase is up (`supabase status`).
- **"Add your OpenAI key" in the panel** — profile parsing needs an OpenAI key; add yours in CareerVine → Settings → AI.
- **Import failures** — check the background service worker console (`chrome://extensions/` → "Service worker" → inspect) and the app's terminal for API errors.
- **Panel changes not showing** — rebuild the panel bundle: `cd panel-app && npm run build`, then reload the extension.
