import './env.js';
import { ensureBucket as ensureR2Bucket, hasCredentials as r2Ready } from './r2.js';

// R2 buckets are created via the S3 API; job records are JSON objects stored
// in the same bucket (no separate database to provision). Run `npm run setup`
// once, or it runs automatically on server start. Requires the Cloudflare R2
// env vars (see .env.example).
export async function setup() {
  if (!r2Ready) {
    console.warn('[setup] Skipped — Cloudflare R2 credentials not configured (see .env.example).');
    return;
  }
  await ensureR2Bucket();
  console.log('[setup] Done.');
}

// Allow `npm run setup` to run standalone.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  setup().catch((err) => {
    console.error('[setup] Failed:', err.message);
    process.exit(1);
  });
}
