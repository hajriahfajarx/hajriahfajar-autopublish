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
 * Downloads the given source URL (e.g. a Pollinations.ai generated image)
 * and re-uploads the bytes to our own R2 bucket, so the final post never
 * depends on the generator's hosting staying available long-term. Returns
 * the stable public URL to embed instead of the original source.
 */
export async function mirrorImageToR2({ client, bucket, publicBaseUrl, sourceUrl, key, contentType = "image/jpeg" }) {
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
}
