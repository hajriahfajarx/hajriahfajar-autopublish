import { uploadJsonToR2 } from "./r2upload.mjs";

const MANIFEST_KEY = "titles/manifest.json";

/**
 * Keeps a small public JSON manifest (postPath -> {id, en}) in the same R2
 * bucket used for thumbnails, so the theme's client-side nav language toggle
 * can swap a post's title everywhere it's shown (its own H1, the browser
 * tab title, and every homepage/category/sidebar listing of it) without
 * Blogger exposing a second title field. Blogger's real post title is a
 * single string (always English here) -- this manifest is the only place
 * the Indonesian title survives past generation time.
 *
 * Best-effort only: a failure here (network blip, R2 hiccup) must NEVER
 * fail a publish -- the theme already falls back to the native title for
 * any post missing from the manifest, same as an old pre-this-feature post.
 */
export async function updateTitlesManifest({ r2Client, bucket, publicBaseUrl }, postPath, { id, en }) {
  try {
    const manifestUrl = `${publicBaseUrl.replace(/\/$/, "")}/${MANIFEST_KEY}`;
    let manifest = {};
    try {
      const res = await fetch(manifestUrl);
      if (res.ok) manifest = await res.json();
    } catch {
      // No manifest yet (first run ever) or a transient fetch error --
      // start from an empty object either way.
    }

    manifest[postPath] = { id, en };

    await uploadJsonToR2({
      client: r2Client,
      bucket,
      publicBaseUrl,
      key: MANIFEST_KEY,
      data: manifest,
    });
  } catch (err) {
    console.warn(`Titles manifest update failed (non-fatal, the post is still published fine): ${err.message}`);
  }
}
