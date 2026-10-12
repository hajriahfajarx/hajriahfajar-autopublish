# hajriahfajar-autopublish

Daily auto-publish pipeline for [hajriahfajar.com](https://hajriahfajar.com) (Blogger): picks a new, non-duplicate topic, writes a bilingual (ID/EN) article using your existing writing-style prompt, generates a thumbnail, validates the output (no leftover placeholders — this publishes straight to production), and posts it to Blogger. Runs daily via GitHub Actions, landing at a randomized time inside a configurable window (default 19:00–20:30 WIB).

## How it works

1. A random delay (0–90 min by default) is applied so the fixed cron trigger lands at a random moment inside the publish window.
2. Reads the Google Sheet log of previously published topics.
3. Asks Gemini to pick one new topic (from the 4 automated categories — **Fragment Hidup is always excluded**, since it needs genuine personal experience, not an AI-invented story).
4. Writes the full article using `prompts/style-guide.md` (your existing style prompt, unchanged) with the topic filled in.
5. Validates the result: checks for leftover template placeholders, missing/short language sections, a missing toggle script. If something's wrong, sends the specific problems back to Gemini to fix, up to 3 attempts total. If it still fails, the run **stops without publishing** and logs a `failed` row instead.
6. Generates a thumbnail image via Pollinations.ai (free, no API key) and inserts it into both language sections.
7. Publishes to Blogger (`isDraft: false`).
8. Logs the result (published or failed) to the Google Sheet.

## One-time setup

### 1. Google Cloud Console (manual, unavoidable)
1. Create or reuse a project at https://console.cloud.google.com.
2. Enable **Blogger API v3** and **Google Sheets API** (APIs & Services → Library).
3. APIs & Services → Credentials → **Create Credentials → OAuth client ID** → Application type: **Desktop app**. Note the Client ID and Client Secret.
4. If prompted, configure the OAuth consent screen (External, testing mode is fine since only you will authorize it).

### 2. Gemini API key
Get one from https://aistudio.google.com/apikey — no OAuth needed, just paste it into the setup form.

### 3. Run the local settings UI
```bash
npm install
npm run setup
```
This opens `http://localhost:5577` in your browser. Fill in the Gemini key, OAuth Client ID/Secret, your blog URL, and click **Connect Google Account** — a Google consent screen opens in a new tab; log in with the account that owns hajriahfajar.com. Once connected, the page auto-detects your Blogger blog ID and creates (or reuses) the Google Sheet log.

Pick which categories should be included (Fragment Hidup is always excluded), set your publish time window, then click **Save**. This writes a local `.env` file. If you've already pushed this repo to GitHub and have the `gh` CLI authenticated, you can also check "push to GitHub Actions secrets" to skip manually pasting values into GitHub's UI.

### 4. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
gh repo create <your-repo-name> --private --source=. --remote=origin
git push -u origin main
```
Then re-run `npm run setup` (or just check the box if you ran it after this step) to push secrets automatically — or add them manually under the repo's **Settings → Secrets and variables → Actions**: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `BLOG_ID`, `SHEET_ID`, `PUBLISH_WINDOW_START`, `PUBLISH_WINDOW_END`, `PUBLISH_TIMEZONE`, `ACTIVE_CATEGORIES`.

GitHub Actions then runs the pipeline daily (`.github/workflows/daily-post.yml`) — no further manual steps needed. You can trigger a one-off test run anytime from the repo's **Actions** tab → "Daily auto-publish" → **Run workflow** (this skips the randomized delay so you see the result immediately).

## Local test run
```bash
SKIP_RANDOM_SLEEP=true npm run run
```

## Notes / known tradeoffs
- `GEMINI_MODEL` defaults to `gemini-flash-latest`, an alias that tracks Google's current best free-tier Flash model — chosen specifically because Google retires specific model versions periodically (e.g. the Gemini 2.5 line is being shut down Oct 16, 2026).
- Thumbnail images are hotlinked directly from Pollinations.ai's URL-based API (no hosting step needed) — if that service ever changes its caching behavior, older post images could stop resolving. Acceptable tradeoff for zero-setup, free image generation.
- The validation step catches leftover placeholders and structural problems, not subtle factual errors — it's pattern-based QA, not full editorial review.
- Re-run `npm run setup` any time to change categories, the publish window, or rotate API keys.
