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
      model: process.env.GEMINI_MODEL || "gemini-flash-latest",
    },
    google: {
      clientId: required("GOOGLE_CLIENT_ID"),
      clientSecret: required("GOOGLE_CLIENT_SECRET"),
      refreshToken: required("GOOGLE_REFRESH_TOKEN"),
    },
    blogId: required("BLOG_ID"),
    sheetId: required("SHEET_ID"),
    publishWindow: {
      start: process.env.PUBLISH_WINDOW_START || "19:00",
      end: process.env.PUBLISH_WINDOW_END || "20:30",
      timezone: process.env.PUBLISH_TIMEZONE || "Asia/Jakarta",
    },
    activeCategories: process.env.ACTIVE_CATEGORIES || "digital-insights,faith-society,productivity,performance-mindset",
    skipRandomSleep: process.env.SKIP_RANDOM_SLEEP === "true",
  };
}
