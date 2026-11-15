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
 * Uploads an already-generated image buffer (from Cloudflare Workers AI) to
 * our own R2 bucket and returns the stable public URL to embed. Simpler than
 * the old Pollinations-era mirroring step, since Workers AI returns the
 * image bytes directly -- no separate "download from a source URL" hop.
 */
export async function uploadBufferToR2({ client, bucket, publicBaseUrl, buffer, key, contentType = "image/jpeg" }) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
}

/**
 * Uploads a plain JSON-serializable value to R2 -- used for the titles
 * manifest (see titlesManifest.mjs). Short cache lifetime since this file
 * gets rewritten a few times a day and the theme's client-side fetch should
 * pick up new entries reasonably soon, without re-fetching on every single
 * pageview.
 */
export async function uploadJsonToR2({ client, bucket, publicBaseUrl, key, data }) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
      CacheControl: "public, max-age=300",
    })
  );

  return `${publicBaseUrl.replace(/\/$/, "")}/${key}`;
}
