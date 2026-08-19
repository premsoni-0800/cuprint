import { randomUUID } from 'node:crypto';
import {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { s3, BUCKET } from './r2.js';

// Print job records live in the SAME Cloudflare R2 bucket as the uploaded
// files, under a `jobs/` prefix (one JSON object per job). This keeps the
// whole print pipeline on Cloudflare — no separate database service needed:
//   • uploaded files  → <bucket>/<storagePath>      (e.g. 1712345678901-abcd.pdf)
//   • job records     → <bucket>/jobs/<id>.json
// Listing is done with ListObjectsV2 over the prefix (the S3 API paginates at
// 1000 objects, which is plenty for a print shop queue; the loop handles more).
const JOBS_PREFIX = 'jobs/';

const jobKey = (id) => `${JOBS_PREFIX}${id}.json`;

async function readJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await res.Body.transformToString();
  return JSON.parse(text);
}

/** All jobs, newest first (by createdAt). */
export async function listJobs() {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: JOBS_PREFIX,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents || []) keys.push(obj.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  const jobs = await Promise.all(keys.map(async (key) => {
    try {
      const doc = await readJson(key);
      const id = key.slice(JOBS_PREFIX.length, -'.json'.length);
      return { id, ...doc };
    } catch (err) {
      console.error('[store] failed to read job record:', key, err.message);
      return null;
    }
  }));
  return jobs
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** One job, or null when the id doesn't exist. */
export async function getJob(id) {
  try {
    const doc = await readJson(jobKey(id));
    return { id, ...doc };
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** Create a job record and return the saved job (with its generated id). */
export async function addJob(record) {
  const job = {
    ...record,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: jobKey(job.id),
    Body: JSON.stringify(job),
    ContentType: 'application/json',
  }));
  return getJob(job.id);
}

/** Merge `patch` into an existing job. Returns the updated job, or null. */
export async function updateJob(id, patch) {
  const job = await getJob(id);
  if (!job) return null;
  const next = {
    ...job,
    ...patch,
    id: job.id,
    createdAt: job.createdAt,
    // Lets the dashboard's silent polling detect that this order changed.
    updatedAt: new Date().toISOString(),
  };
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: jobKey(id),
    Body: JSON.stringify(next),
    ContentType: 'application/json',
  }));
  return next;
}

/**
 * Update a job record WITHOUT stamping a new updatedAt. Used for internal
 * bookkeeping (e.g. marking the uploaded file as deleted) — the retention
 * clock is driven by updatedAt, so cleaning up the file must never reset it.
 */
export async function updateJobSilent(id, patch) {
  const job = await getJob(id);
  if (!job) return null;
  const next = {
    ...job,
    ...patch,
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: jobKey(id),
    Body: JSON.stringify(next),
    ContentType: 'application/json',
  }));
  return next;
}

/** Remove a job record (does NOT delete the uploaded file — caller does that). */
export async function deleteJobRecord(id) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: jobKey(id) }));
}
