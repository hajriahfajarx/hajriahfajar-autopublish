# hajriahfajar-autopublish

Daily auto-publish pipeline for [hajriahfajar.com](https://hajriahfajar.com) (Blogger): picks a new, non-duplicate topic, writes a bilingual (ID/EN) article using your existing writing-style prompt, generates a thumbnail, validates the output (no leftover placeholders — this publishes straight to production), and posts it to Blogger. Runs daily via GitHub Actions, landing at a randomized time inside a configurable window (default 19:00–20:30 WIB).

## How it works

1. GitHub Actions fires 6 small cron triggers spread across the publish window (every 15 min, 19:00–20:15 WIB). A dependency-free pre-check (`scripts/check-slot.mjs`) picks exactly one of them per day via a deterministic hash of today's date — the other 5 exit in a few seconds without installing anything. This gives a randomized daily publish time **without** burning Actions minutes on an in-runner sleep (an earlier version of this did that — don't bring it back, it ate ~90 min/day of billable runner time for nothing).
2. The chosen run reads the Google Sheet log of previously published topics, and skips immediately if today's already been handled (safety net against double-posting).
3. Asks Gemini to pick one new topic (from the 4 automated categories — **Fragment Hidup is always excluded**, since it needs genuine personal experience, not an AI-invented story).
4. Writes the full article using `prompts/style-guide.md` (your existing style prompt, unchanged) with the topic filled in.
5. Validates the result: checks for leftover template placeholders, missing/short language sections, a missing toggle script. If something's wrong, sends the specific problems back to Gemini to fix, up to 3 attempts total. If it still fails, the run **stops without publishing** and logs a `failed` row instead.
6. Generates a thumbnail image via Pollinations.ai (free, no API key), downloads it, and re-uploads it to your own Cloudflare R2 bucket — so posts don't depend on Pollinations' hosting staying available long-term. If image generation/mirroring fails after retries, the article still publishes, just without an image.
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

### 3. Cloudflare R2 (thumbnail storage)
1. Enable R2 once for your account at the Cloudflare dashboard (R2 Object Storage → Enable R2) — the free tier (10GB) is plenty for small JPEG thumbnails.
2. `npx wrangler r2 bucket create <bucket-name>`
3. Connect a **custom domain you own** (do NOT use the shared `*.r2.dev` URL — it's shared across every free R2 user worldwide and can get blocked wholesale by some ISPs; hit this for real in testing):
   ```bash
   npx wrangler r2 bucket domain add <bucket-name> --domain img.yourdomain.com --zone-id <your-zone-id> --min-tls 1.2
   ```
   (Zone ID is on your domain's Cloudflare dashboard Overview page.) Wait a minute or two for `ownership_status`/`ssl_status` to go `active` (`npx wrangler r2 bucket domain get <bucket-name> --domain img.yourdomain.com`).
4. **Make sure that domain's zone is NOT in "Under Attack Mode"** (Cloudflare dashboard → your domain → Overview) — it blocks image sub-resource requests (not just full-page loads), which silently breaks every thumbnail. This mode is meant only for active DDoS mitigation, not normal operation.
5. Dashboard → R2 Object Storage → **Manage R2 API Tokens** → Create **Account API token** (not User token) → Permission: **Object Read & Write**, scoped to this bucket only. Save the Access Key ID + Secret Access Key (shown once).

### 4. Run the local settings UI
```bash
npm install
npm run setup
```
This opens `http://localhost:5577` in your browser. Fill in the Gemini key, OAuth Client ID/Secret, your blog URL, and click **Connect Google Account** — a Google consent screen opens in a new tab; log in with the account that owns hajriahfajar.com. Once connected, the page auto-detects your Blogger blog ID and creates (or reuses) the Google Sheet log.

Fill in the R2 fields from step 3, pick which categories should be included (Fragment Hidup is always excluded), set your publish time window, then click **Save**. This writes a local `.env` file. If you've already pushed this repo to GitHub and have the `gh` CLI authenticated, you can also check "push to GitHub Actions secrets" to skip manually pasting values into GitHub's UI.

### 5. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
gh repo create <your-repo-name> --public --source=. --remote=origin
git push -u origin main
```
**Public, not private** — GitHub Actions minutes are unlimited/free on public repos, but metered (shared across your whole account) on private ones; this pipeline's own secrets stay safe either way since they're GitHub-encrypted secrets, never committed to the repo itself.

Then re-run `npm run setup` (or just check the box if you ran it after this step) to push secrets automatically — or add them manually under the repo's **Settings → Secrets and variables → Actions**: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `BLOG_ID`, `SHEET_ID`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL`, `PUBLISH_WINDOW_START`, `PUBLISH_WINDOW_END`, `PUBLISH_TIMEZONE`, `ACTIVE_CATEGORIES`.

GitHub Actions then runs the pipeline daily (`.github/workflows/daily-post.yml`) — no further manual steps needed. You can trigger a one-off test run anytime from the repo's **Actions** tab → "Daily auto-publish" → **Run workflow** (manual runs always proceed immediately, bypassing the slot check).

## Local test run
```bash
npm run run
```
Add `DRAFT_MODE=true` (e.g. `DRAFT_MODE=true npm run run`) to save the post as a Blogger draft instead of actually publishing — useful for smoke-testing changes. This is local-only and intentionally never set as a GitHub secret, so the real scheduled runs always publish for real.

Add `FORCE_RUN=true` to bypass the same-day dedup guard for manual re-testing (e.g. if you've already triggered a real/draft run today and want to try again). Also local-only, never a GitHub secret.

## Notes / known tradeoffs
- `GEMINI_MODEL` defaults to `gemini-flash-latest,gemini-flash-lite-latest` (comma-separated, tried in order with its own retry-with-backoff before falling through) — `gemini-flash-latest` is an alias that tracks Google's current best free-tier Flash model, chosen because Google retires specific model versions periodically (e.g. the Gemini 2.5 line is being shut down Oct 16, 2026); the Flash-Lite fallback covers the primary model being temporarily overloaded. During a real Gemini outage (widespread 503s), even a "successful" response can occasionally skip the expected BAGIAN A/BAGIAN B format — `writeArticle`+parse gets up to 2 full attempts for this before giving up and logging a clean `failed` row.
- The publish window (default 19:00–20:30 WIB, 6 slots of 15 min) is controlled by **two places that must stay in sync**: the `schedule:` entries in `.github/workflows/daily-post.yml` and the `CRON_TO_SLOT` map in `scripts/check-slot.mjs`. Changing the window means editing both. `PUBLISH_WINDOW_START`/`END` env vars are informational only at this point (not used for the actual gating).
- Keep the repo **public** (see step 5) — GitHub's scheduled-workflow delivery can also be delayed by hours on its own, independent of billing, so don't be alarmed if a run fires later than its cron time; the slot-matching logic still picks exactly one per day regardless of when each trigger actually fires.
- Thumbnails are downloaded from Pollinations.ai and re-uploaded to your own Cloudflare R2 bucket (see setup step 3) rather than hotlinked — Pollinations gives no retention guarantee and is a small, unproven company. If mirroring fails after retries, the post still publishes, just without an image.
- The validation step catches leftover placeholders and structural problems, not subtle factual errors — it's pattern-based QA, not full editorial review.
- Re-run `npm run setup` any time to change categories or rotate API keys.
