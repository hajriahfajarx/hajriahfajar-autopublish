import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Run "npm run setup" or copy .env.example to .env.`);
  }
  return value;
}

export function loadConfig() {
  return {
    gemini: {
      apiKey: required("GEMINI_API_KEY"),
      // Tried in order; falls through to the next only once the previous
      // model has exhausted its own retries (see generateContentWithFallback
      // in gemini.mjs). Protects against one model being temporarily
      // overloaded — observed in practice with gemini-flash-latest (503).
      models: (process.env.GEMINI_MODEL || "gemini-flash-latest,gemini-flash-lite-latest")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    },
    google: {
      clientId: required("GOOGLE_CLIENT_ID"),
      clientSecret: required("GOOGLE_CLIENT_SECRET"),
      refreshToken: required("GOOGLE_REFRESH_TOKEN"),
    },
    blogId: required("BLOG_ID"),
    sheetId: required("SHEET_ID"),
    r2: {
      accountId: required("R2_ACCOUNT_ID"),
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
      bucket: required("R2_BUCKET_NAME"),
      publicBaseUrl: required("R2_PUBLIC_BASE_URL"),
    },
    publishWindow: {
      // Which of the 3 daily windows (morning/midday/evening) this run
      // belongs to — set by the GitHub Actions workflow from check-slot's
      // output. "manual" for workflow_dispatch / local runs (dedup is
      // skipped for those, see alreadyHandledToday in run.mjs).
      id: process.env.PUBLISH_WINDOW_ID || "manual",
      timezone: process.env.PUBLISH_TIMEZONE || "Asia/Jakarta",
    },
    activeCategories: process.env.ACTIVE_CATEGORIES || "digital-insights,faith-society,productivity,performance-mindset",
    // Not a GitHub secret — local-only override for manually testing the
    // pipeline without actually publishing live. Defaults to false (real
    // auto-publish) everywhere this isn't explicitly set.
    draftMode: process.env.DRAFT_MODE === "true",
  };
}
