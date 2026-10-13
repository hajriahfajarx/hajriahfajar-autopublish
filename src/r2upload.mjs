import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export function createR2Client({ accountId, accessKeyId, secretAccessKey }) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // Newer AWS SDK v3 versions attach request checksums by default, which
    // R2's S3-compatible API doesn't fully support and rejects (surfaces as
    // a confusing AccessDenied rather than a checksum-specific error).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/**
 * Downloads a source image (e.g. from Pollinations.ai) and re-uploads the
 * bytes to our own R2 bucket, so the final post never depends on the
 * generator's hosting staying available long-term. Returns the stable
 * public URL to embed instead of the original source.
 *
 * `buildSourceUrl` is a function (not a fixed URL) because Pollinations
 * occasionally returns a transient 5xx for a given generation -- retrying
 * with a freshly-built URL (new random seed) has a better chance of
 * succeeding than retrying the exact same URL. Throws only after all
 * retries are exhausted; callers should treat that as "no image this time"
 * rather than failing the whole article (seen in practice: a good,
 * validated article shouldn't go to waste over an unrelated third-party
 * image-generator hiccup).
 */
export async function mirrorImageToR2({ client, bucket, publicBaseUrl, buildSourceUrl, key, contentType = "image/jpeg", retries = 2, baseDelayMs = 3000 }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const sourceUrl = buildSourceUrl();
    try {
      const res = await fetch(sourceUrl);
      if (!res.ok) {
        throw new Error(`Failed to download source image for R2 mirroring: ${res.status} ${sourceUrl}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
        })
      );

      return `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        console.log(`Thumbnail mirroring failed (${err.message}), retrying in ${delay / 1000}s with a fresh URL... (attempt ${attempt + 1}/${retries})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}
