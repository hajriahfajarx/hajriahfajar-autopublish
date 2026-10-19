// Generates thumbnail images via Cloudflare Workers AI (FLUX.1 [schnell])
// instead of Pollinations.ai. Free tier: 10,000 Workers AI "neurons"/day,
// which is roughly 230 FLUX image generations/day -- far more than this
// pipeline's few thumbnails per day need. Switched from Pollinations.ai
// after it started intermittently returning 402/503 for anonymous
// (no-account) requests.
//
// REST endpoint confirmed from Cloudflare's own docs
// (developers.cloudflare.com/workers-ai/models/flux-1-schnell/) AND verified
// with a real test call:
//   POST https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell
//   Authorization: Bearer {apiToken}
//   body: { "prompt": "..." }
// NOTE: the docs' own curl example shows a "seed" field, but the model's
// actual input schema only accepts `prompt` (required, 1-2048 chars) and
// `steps` (optional, max 8, default 4) -- a real test call with "seed" set
// failed with "Additional properties '/seed' not allowed" (error 5006).
// Response is the standard Cloudflare API v4 envelope ({success, result,
// errors}), with `result.image` being a base64-encoded JPEG.
const MODEL = "@cf/black-forest-labs/flux-1-schnell";

async function generateOnce({ accountId, apiToken, prompt }) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: prompt.trim() }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Cloudflare Workers AI request failed: ${res.status} ${bodyText.slice(0, 300)}`);
  }

  const data = await res.json();
  // Defensive: handle both the standard {result:{image}} envelope and an
  // unwrapped {image} shape, in case the REST response differs from the
  // Workers-binding example shown in the docs.
  const base64Image = data?.result?.image ?? data?.image;
  if (data.success === false || !base64Image) {
    throw new Error(`Cloudflare Workers AI returned no image: ${JSON.stringify(data.errors || data).slice(0, 300)}`);
  }

  return Buffer.from(base64Image, "base64");
}

/**
 * Retries on failure (mirrors the old Pollinations mirroring retry
 * behavior) -- callers should treat an exhausted retry as "no image this
 * time" rather than failing the whole article.
 */
export async function generateImageWithRetry({ accountId, apiToken, prompt, retries = 2, baseDelayMs = 3000 }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await generateOnce({ accountId, apiToken, prompt });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.log(`Cloudflare Workers AI image generation failed (${err.message}), retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${retries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}
