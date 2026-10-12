// The 5 categories from the user's style guide. Fragment Hidup is defined here
// for reference/labeling only — it is never selected by the automated topic
// picker (see ALL_CATEGORIES vs the ACTIVE_CATEGORIES env var in run.mjs).
export const ALL_CATEGORIES = {
  "digital-insights": {
    label: "Digital Insights",
    description:
      "AI, tools, software, website, internet, keamanan digital, aplikasi, hardware, troubleshooting, programming, cloud, teknologi, atau solusi digital.",
  },
  "faith-society": {
    label: "Faith & Society",
    description:
      "Islam, agama, hukum agama, dosa, ibadah, masyarakat, nilai kehidupan, fenomena sosial, atau klarifikasi isu berdasarkan nilai agama.",
  },
  productivity: {
    label: "Productivity",
    description:
      "fokus kerja, malas, burnout, mahasiswa, freelancer, workflow, manajemen waktu, efisiensi kerja, kebiasaan kerja, atau produktivitas.",
  },
  "performance-mindset": {
    label: "Performance Mindset",
    description:
      "disiplin, konsistensi, kebiasaan, sistem hidup, karakter, pengembangan diri, mentalitas, atau studi kasus tokoh nyata yang digunakan sebagai pelajaran hidup.",
  },
  "fragment-hidup": {
    label: "Fragment Hidup",
    description:
      "cerita kehidupan pribadi, curhat, pengalaman, keresahan — EXCLUDED dari rotasi otomatis karena butuh pengalaman pribadi asli.",
  },
};

export function getActiveCategories(activeCategoriesEnv) {
  const slugs = (activeCategoriesEnv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const resolved = slugs
    .filter((slug) => slug !== "fragment-hidup")
    .map((slug) => {
      const def = ALL_CATEGORIES[slug];
      if (!def) throw new Error(`Unknown category slug in ACTIVE_CATEGORIES: "${slug}"`);
      return { slug, ...def };
    });

  if (resolved.length === 0) {
    throw new Error("ACTIVE_CATEGORIES resolved to zero usable categories (fragment-hidup is always excluded).");
  }

  return resolved;
}
