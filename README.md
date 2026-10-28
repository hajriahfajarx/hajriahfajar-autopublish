# hajriahfajar-autopublish

Auto-publish pipeline for [hajriahfajar.com](https://hajriahfajar.com) (Blogger): writes bilingual (ID/EN) articles using your existing writing-style prompt, generates a thumbnail, validates the output (no leftover placeholders — this publishes straight to production), and posts it to Blogger. Runs **2x/day** via GitHub Actions, spread across 2 independent daily windows targeting a real-world landing around morning 07:00–09:30 WIB and evening 19:00–20:30 WIB (configured cron times are shifted earlier in UTC to compensate for observed GitHub scheduling delay — see `scripts/check-slot.mjs`), each landing at its own randomized time within the window.

- **Morning** is special: always **Digital Insights**, and the topic comes from real, current tech news headlines (free public RSS feeds — TechCrunch, The Verge, Ars Technica), not the model's static training data. Gemini's job there is judgment (pick the one appropriate, interesting mainstream story — explicitly told to skip crime/legal/disturbing content, which raw news feeds do include) and structuring, not invention. **Writes live, real-time, at publish time** — pre-writing "today's trending news" days in advance would make it stale, so this window is never batched.
- **Evening**: normal category rotation across whichever categories are active. **Batched** — see below.

## Two-phase model: generate weekly, publish daily from a queue

The evening window **no longer calls Gemini at publish time at all**. Instead:

1. **Generate** (`src/generate.mjs`, run via `.github/workflows/generate.yml`) writes several (default 10) complete, validated, ready-to-publish articles in one batch run — once a week, off-peak (Monday 10:00 UTC / 17:00 WIB), outside both publish windows — and queues them in the Google Sheet with `status = ready` (full HTML included, nothing left to generate later).
2. **Publish** (`src/run.mjs`, the existing daily-windowed workflow) just pulls the **oldest `ready` row**, generates a fresh thumbnail for it (Cloudflare Workers AI — separate, far more reliable quota than Gemini's, so still done live), marks the row `done`, and posts it.

This exists because calling Gemini at every single publish moment (2x/day, every day) was exactly what caused a string of failures: Gemini's free tier occasionally has multi-minute 503/429 overload spells that exhaust both the primary and fallback model mid-publish. Batching means Gemini is only ever invoked during one deliberate weekly window, not scattered across every daily publish attempt — and a publish-time failure becomes nearly impossible for this window, since there's no Gemini call left to fail.

**Manual "dashboard"**: open the repo's **Actions** tab → **Weekly batch generate** → **Run workflow** to generate on demand (optionally with a custom count) whenever you want to top up the queue early. The Google Sheet itself is the visual queue dashboard — filter/sort by `status` to see what's `ready` vs `done` vs `failed`.

If the queue runs dry (no `ready` row left for the evening window when a publish slot fires), `run.mjs` logs a clear warning and does nothing that run — it does **not** fall back to generating on the fly. Keep an eye on the queue depth (10/week generated vs 7/week consumed gives a few days of buffer, covering occasional generate-time failures) and re-run the generate workflow manually if it ever looks low.

## How it works

1. GitHub Actions fires 16 small cron triggers total (10 for the morning window, 6 for evening, every 15 min, uncommon minute offsets). A dependency-free pre-check (`scripts/check-slot.mjs`) picks exactly one slot per window per day via a deterministic hash of today's date + window name — the others exit in a few seconds without installing anything. This gives 2 randomized daily publish times **without** burning Actions minutes on an in-runner sleep (an earlier version of this did that for a single daily post — don't bring it back, it ate ~90 min/day of billable runner time for nothing).
2. The chosen run reads the Google Sheet log, and skips immediately if *that window* has already been handled today (safety net against double-posting — the other window is unaffected).
3. **Morning**: picks from current RSS tech news (see above), writes the full article live using `prompts/style-guide.md`, validates (repair loop, up to 3 attempts), generates a thumbnail, publishes, logs `published`/`failed`.
4. **Evening**: pulls the oldest `ready` row from the queue (see "Two-phase model" above), generates a thumbnail for it, publishes, and flips that row to `done`. No Gemini call in this path.

## One-time setup

### 1. Google Cloud Console (manual, unavoidable)
1. Create or reuse a project at https://console.cloud.google.com.
2. Enable **Blogger API v3** and **Google Sheets API** (APIs & Services → Library).
3. APIs & Services → Credentials → **Create Credentials → OAuth client ID** → Application type: **Desktop app**. Note the Client ID and Client Secret.
4. If prompted, configure the OAuth consent screen (External, testing mode is fine since only you will authorize it).

### 2. Gemini API key
Get one from https://aistudio.google.com/apikey — no OAuth needed, just paste it into the setup form.

### 3. Cloudflare Workers AI (thumbnail generation)
Dashboard → click your profile icon (top right) → **My Profile** → **API Tokens** → **Create Token** → template **"Workers AI (Read)"** (or custom: Account → Workers AI → Read) → Create. Save the token (shown once) — this is `CLOUDFLARE_API_TOKEN`.

### 4. Cloudflare R2 (thumbnail storage)
1. Enable R2 once for your account at the Cloudflare dashboard (R2 Object Storage → Enable R2) — the free tier (10GB) is plenty for small JPEG thumbnails.
2. `npx wrangler r2 bucket create <bucket-name>`
3. Connect a **custom domain you own** (do NOT use the shared `*.r2.dev` URL — it's shared across every free R2 user worldwide and can get blocked wholesale by some ISPs; hit this for real in testing):
   ```bash
   npx wrangler r2 bucket domain add <bucket-name> --domain img.yourdomain.com --zone-id <your-zone-id> --min-tls 1.2
   ```
   (Zone ID is on your domain's Cloudflare dashboard Overview page.) Wait a minute or two for `ownership_status`/`ssl_status` to go `active` (`npx wrangler r2 bucket domain get <bucket-name> --domain img.yourdomain.com`).
4. **Make sure that domain's zone is NOT in "Under Attack Mode"** (Cloudflare dashboard → your domain → Overview) — it blocks image sub-resource requests (not just full-page loads), which silently breaks every thumbnail. This mode is meant only for active DDoS mitigation, not normal operation.
5. Dashboard → R2 Object Storage → **Manage R2 API Tokens** → Create **Account API token** (not User token) → Permission: **Object Read & Write**, scoped to this bucket only. Save the Access Key ID + Secret Access Key (shown once). The **Account ID** here is the same one used for Workers AI in step 3.

### 5. Run the local settings UI
```bash
npm install
npm run setup
```
This opens `http://localhost:5577` in your browser. Fill in the Gemini key, OAuth Client ID/Secret, your blog URL, and click **Connect Google Account** — a Google consent screen opens in a new tab; log in with the account that owns hajriahfajar.com. Once connected, the page auto-detects your Blogger blog ID and creates (or reuses) the Google Sheet log.

Fill in the Cloudflare API Token from step 3 and the R2 fields from step 4, pick which categories should be included (Fragment Hidup is always excluded), set your publish time window, then click **Save**. This writes a local `.env` file. If you've already pushed this repo to GitHub and have the `gh` CLI authenticated, you can also check "push to GitHub Actions secrets" to skip manually pasting values into GitHub's UI.

### 6. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
gh repo create <your-repo-name> --public --source=. --remote=origin
git push -u origin main
```
**Public, not private** — GitHub Actions minutes are unlimited/free on public repos, but metered (shared across your whole account) on private ones; this pipeline's own secrets stay safe either way since they're GitHub-encrypted secrets, never committed to the repo itself.

Then re-run `npm run setup` (or just check the box if you ran it after this step) to push secrets automatically — or add them manually under the repo's **Settings → Secrets and variables → Actions**: `GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `BLOG_ID`, `SHEET_ID`, `CLOUDFLARE_API_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL`, `PUBLISH_TIMEZONE`, `ACTIVE_CATEGORIES`. (`PUBLISH_WINDOW_ID` is not a secret — it's injected per-run by the workflow itself from `check-slot.mjs`'s output.)

GitHub Actions then runs the pipeline daily (`.github/workflows/daily-post.yml`) — no further manual steps needed, **except** the evening window needs its queue topped up: either wait for the weekly `generate.yml` schedule, or trigger it manually once right after setup (Actions tab → "Weekly batch generate" → **Run workflow**) so there's something `ready` to publish immediately. You can also trigger a one-off publish test run anytime from "Daily auto-publish" → **Run workflow** (manual runs always proceed immediately, bypassing the slot check).

## Local test run
```bash
npm run run
```
Add `DRAFT_MODE=true` (e.g. `DRAFT_MODE=true npm run run`) to save the post as a Blogger draft instead of actually publishing — useful for smoke-testing changes. This is local-only and intentionally never set as a GitHub secret, so the real scheduled runs always publish for real.

Add `FORCE_RUN=true` to bypass the same-day dedup guard for manual re-testing (e.g. if you've already triggered a real/draft run today and want to try again). Also local-only, never a GitHub secret.

To generate a batch locally (writes real `ready`/`failed` rows to the Sheet, no Blogger calls at all):
```bash
GENERATE_COUNT=3 npm run generate
```

## Notes / known tradeoffs
- `GEMINI_MODEL` defaults to `gemini-flash-latest,gemini-flash-lite-latest` (comma-separated, tried in order with its own retry-with-backoff before falling through) — `gemini-flash-latest` is an alias that tracks Google's current best free-tier Flash model, chosen because Google retires specific model versions periodically (e.g. the Gemini 2.5 line is being shut down Oct 16, 2026); the Flash-Lite fallback covers the primary model being temporarily overloaded. During a real Gemini outage (widespread 503s), even a "successful" response can occasionally skip the expected BAGIAN A/BAGIAN B format — `writeArticle`+parse gets up to 2 full attempts for this before giving up and logging a clean `failed` row.
- The 2 daily windows (morning 10 slots + evening 6 slots = 16 cron entries total; configured times are shifted earlier than the real target WIB times to compensate for observed GitHub scheduling delay — see the "scheduling delay" note below) are controlled by **two places that must stay in sync**: the `schedule:` entries in `.github/workflows/daily-post.yml` and the `CRON_MAP` in `scripts/check-slot.mjs`. Changing the windows/times/count-per-day means editing both.
- **GitHub scheduling delay (observed, not just theoretical)**: this account's scheduled workflow triggers were observed landing ~3-4.5h later than their configured cron time across all 3 sibling projects, likely queuing congestion since most repos worldwide schedule on the same popular `:00/:15/:30/:45` minute marks. The configured cron times here are deliberately shifted earlier (and use uncommon minute offsets like `:07/:22/:37/:52`) to compensate, targeting a real-world landing close to the intended WIB windows. This is a best-effort estimate from a limited sample — monitor actual publish timestamps (Blogger post dates / Sheet log) periodically and re-tune the cron times if the delay pattern drifts.
- Dedup is per-window, not per-day: only a `published` (morning) or `done` (evening) row — tagged with which window produced it — blocks that same window from running again today. A `failed` row does **not** block — if a morning slot's live write fails (e.g. a transient Gemini 503 overload spell), the next slot in the same window retries from scratch later that day, instead of the whole window going silent until tomorrow. Rows from before per-window tracking existed default to `evening` for backward compatibility.
- The evening Sheet rows now carry the full `content_html`/`alt_text`/`thumbnail_prompt` for queued (`ready`) articles — these can get long; that's expected and well within Google Sheets' per-cell limit.
- Morning's RSS feed list lives in `FEEDS` in `src/techNews.mjs` — add/remove feeds there if you want different sources. Each feed is fetched independently and failures are logged but don't block the others.
- Keep the repo **public** (see step 6) — GitHub's scheduled-workflow delivery can also be delayed by hours on its own, independent of billing, so don't be alarmed if a run fires later than its cron time; the slot-matching logic still picks exactly one per day regardless of when each trigger actually fires.
- Thumbnails are generated via Cloudflare Workers AI (FLUX.1 [schnell]) and uploaded directly to your own Cloudflare R2 bucket (see setup steps 3–4). Previously used Pollinations.ai (free, no API key) but switched away after it started intermittently returning `402`/`503` for anonymous requests — Workers AI uses the same Cloudflare account already set up for R2, with a far more generous and reliable free tier (~230 images/day). If generation/upload fails after retries, the post still publishes, just without an image.
- The validation step catches leftover placeholders and structural problems, not subtle factual errors — it's pattern-based QA, not full editorial review.
- Re-run `npm run setup` any time to change categories or rotate API keys.
