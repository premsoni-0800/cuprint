import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Cloudflare R2 is S3-compatible. Credentials come from the Cloudflare
// dashboard (R2 → Manage R2 API Tokens). The bucket holds uploaded print files.
export const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
export const ACCESS_KEY_ID = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
export const SECRET_ACCESS_KEY = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
export const BUCKET = process.env.R2_BUCKET_NAME || 'print-jobs';

export const hasCredentials = Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY);

if (!hasCredentials) {
  console.warn('[r2] Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_R2_ACCESS_KEY_ID / CLOUDFLARE_R2_SECRET_ACCESS_KEY — uploads will fail until configured.');
}

export const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: ACCESS_KEY_ID || 'missing',
    secretAccessKey: SECRET_ACCESS_KEY || 'missing',
  },
});

/** Presigned PUT URL — the browser uploads the file directly to R2. */
export const createUploadUrl = (key, mimeType, expiresIn = 600) =>
  getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: mimeType || 'application/octet-stream' }), { expiresIn });

/** Presigned GET URL — inline (preview) or attachment (download). */
export const createGetUrl = (key, { download = false, filename = '', expiresIn = 86400 } = {}) =>
  getSignedUrl(s3, new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: download
      ? `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`
      : 'inline',
  }), { expiresIn });

export const deleteObject = (key) =>
  s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

// ── Reviews bucket ───────────────────────────────────────────────────────────
// The site's anonymous ratings are stored as one small JSON object per review
// in a separate "reviews" bucket (browsable in the R2 console), so they never
// mix with the print files. The site writes via POST /api/reviews and the
// public /reviews page reads via GET /api/reviews.
export const REVIEWS_BUCKET = process.env.REVIEWS_BUCKET_NAME || 'reviews';

/** Store a small JSON object in a bucket (server-side PUT — no presigning needed). */
export const putJsonObject = (bucket, key, data) =>
  s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(data),
    ContentType: 'application/json',
  }));

/** List every object under a prefix in a bucket (handles pagination). */
export const listObjects = async (bucket, prefix = '') => {
  const out = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(token ? { ContinuationToken: token } : {}),
    }));
    out.push(...(page.Contents || []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
};

/** Fetch and parse a JSON object from a bucket (null when unreadable). */
export const getJsonObject = async (bucket, key) => {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await obj.Body.transformToString();
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Idempotent — create the bucket if it doesn't exist (R2 supports CreateBucket via the S3 API). */
export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`[r2] Bucket "${BUCKET}" exists.`);
    return;
  } catch (err) {
    // Only try to create when the bucket is actually missing (404 / NoSuchBucket).
    // An API token scoped to "Object Read & Write" cannot create buckets — that
    // needs Admin. In that case log a hint instead of crashing the server.
    const denied = err?.$metadata?.httpStatusCode === 403 || err?.name === 'AccessDenied';
    if (!denied) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
        console.log(`[r2] Created bucket "${BUCKET}".`);
        return;
      } catch (createErr) {
        err = createErr;
      }
    }
    console.warn(
      `[r2] Could not verify/create bucket "${BUCKET}": ${err?.message || err}. ` +
      'Create it manually in the Cloudflare dashboard (R2 → Create bucket → name it ' +
      `"${BUCKET}") or use a token with Admin permission if it should be auto-created.`
    );
  }
}
