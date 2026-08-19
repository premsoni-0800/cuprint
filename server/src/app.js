import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import { createUploadUrl, createGetUrl, deleteObject, putJsonObject, listObjects, getJsonObject, REVIEWS_BUCKET } from './r2.js';
import { listJobs, getJob, addJob, updateJob, updateJobSilent, deleteJobRecord } from './store.js';
import { getWallet, credit, debitWallet, refund as refundWallet } from './walletStore.js';
import { getShopByOwner, listShops, createShop, deleteShop } from './shopStore.js';

const STATUSES = ['new', 'printing', 'ready', 'completed'];

// Completed orders: the customer's pickup deadline is 30 hours. At 30h the
// order moves to the BIN (hidden from the active queue but still visible to
// the owner, so someone arriving at the 36th hour can still be helped). At
// 36h the uploaded FILE is deleted, but the record (pickup code, name, UID,
// …) is kept in the bin for 7 days; only then is the record removed too.
const JOB_BIN_MS = 30 * 60 * 60 * 1000;                 // completed → bin
const JOB_FILE_DELETE_MS = 36 * 60 * 60 * 1000;         // delete the file, keep the data
const JOB_RECORD_DELETE_MS = 7 * 24 * 60 * 60 * 1000;   // delete the record too

// Age of a completed order since it was marked completed (ms since updatedAt).
const completedAgeMs = (job) => {
  const ts = job.updatedAt || job.createdAt;
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? Date.now() - t : null;
};

// 30h → 7d: in the bin — hidden from the queue, listed by /api/jobs/bin.
const isBinned = (job) => {
  if (job.status !== 'completed') return false;
  const age = completedAgeMs(job);
  return age !== null && age >= JOB_BIN_MS && age < JOB_RECORD_DELETE_MS;
};

// ≥7d: the whole record is permanently deletable.
const isExpired = (job) => {
  if (job.status !== 'completed') return false;
  const age = completedAgeMs(job);
  return age !== null && age >= JOB_RECORD_DELETE_MS;
};

// A scheduled print whose time hasn't arrived yet — it stays hidden from the
// owner's queue until the customer's chosen time, so the queue only shows
// orders the shop actually needs to work on now.
const isScheduledFuture = (job) => {
  if (!job.scheduledFor) return false;
  const t = new Date(job.scheduledFor).getTime();
  return Number.isFinite(t) && t > Date.now();
};

// Retention sweep. Runs on queue reads (works on serverless hosts, no
// background timer needed):
//   • ≥36h  → delete the uploaded file, keep the record (data stays visible)
//   • ≥7d   → delete the record entirely
// Returns the ids of fully-purged jobs so callers can drop them from an
// already-loaded list.
async function purgeExpiredJobs() {
  const purged = [];
  try {
    const jobs = await listJobs();
    for (const job of jobs) {
      if (job.status !== 'completed') continue;
      const age = completedAgeMs(job);
      if (age === null) continue;

      // 36h: file goes, data stays. fileDeletedAt is marked WITHOUT touching
      // updatedAt, so the 7-day record clock keeps running from completion.
      if (age >= JOB_FILE_DELETE_MS && !job.fileDeletedAt) {
        try {
          await deleteObject(job.storagePath);
        } catch (err) {
          console.error('[jobs] R2 file delete failed for completed job:', job.id, err.message);
        }
        try {
          await updateJobSilent(job.id, { fileDeletedAt: new Date().toISOString() });
        } catch (err) {
          console.error('[jobs] failed to mark file as deleted:', job.id, err.message);
        }
      }

      // 7 days: the whole record is gone.
      if (age >= JOB_RECORD_DELETE_MS) {
        purged.push(job.id);
        await deleteJobRecord(job.id);
      }
    }
    if (purged.length) {
      console.log(`[jobs] removed ${purged.length} completed order record(s) past the 7-day retention`);
    }
  } catch (err) {
    console.error('[jobs] auto-purge failed:', err.message);
  }
  return purged;
}

const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
  'doc', 'docx', 'txt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx',
]);

const toIso = (ts) => {
  if (!ts) return null;
  if (typeof ts === 'string') return ts;
  if (ts.seconds) return new Date(ts.seconds * 1000).toISOString();
  return null;
};

/** Stored job record → API job shape. `urls` carries the fresh presigned R2 URLs. */
const jobToApi = (job, urls = {}) => ({
  id: job.id,
  stored_name: job.storagePath,
  original_name: job.originalName,
  mime_type: job.mimeType,
  size: job.size,
  customer_name: job.customerName,
  notes: job.notes,
  customer_email: job.customerEmail || null,
  customer_uid: job.customerUid || null,
  status: job.status,
  created_at: toIso(job.createdAt),
  updated_at: toIso(job.updatedAt),
  // 4-digit pickup code the customer shows at the shop to collect the printout.
  order_code: job.orderCode || null,
  // Groups every file of one order (they share the same pickup code).
  order_id: job.orderId || null,
  // Which registered shop this order was sent to.
  shop_id: job.shopId || null,
  shop_name: job.shopName || null,
  // Colour print request (true = colour, false/null = black & white).
  color: job.color ? true : false,
  // True once the uploaded file was deleted at the 36h mark (data stays).
  file_deleted: job.fileDeletedAt ? true : false,
  // Customer-chosen future time — the job is hidden from the queue until then.
  scheduled_for: toIso(job.scheduledFor),
  file_url: urls.preview,
  download_url: urls.download,
});

/** Lightweight metadata shape — used by the dashboard's silent polling. NEVER
 * presigns R2 URLs, so polling costs one metadata read and no R2 file work. */
const jobToMeta = (job) => ({
  id: job.id,
  stored_name: job.storagePath,
  original_name: job.originalName,
  mime_type: job.mimeType,
  size: job.size,
  customer_name: job.customerName,
  notes: job.notes,
  customer_email: job.customerEmail || null,
  customer_uid: job.customerUid || null,
  status: job.status,
  created_at: toIso(job.createdAt),
  updated_at: toIso(job.updatedAt),
  order_code: job.orderCode || null,
  order_id: job.orderId || null,
  shop_id: job.shopId || null,
  shop_name: job.shopName || null,
  color: job.color ? true : false,
  // True once the uploaded file was deleted at the 36h mark (data stays).
  file_deleted: job.fileDeletedAt ? true : false,
  // Customer-chosen future time — the job is hidden from the queue until then.
  scheduled_for: toIso(job.scheduledFor),
});

/** A random 4-digit pickup code (1000–9999). */
const randomOrderCode = () => String(Math.floor(1000 + Math.random() * 9000));

/** Presign both the inline preview and the download URL for a stored file. */
async function presignUrls(storagePath, originalName) {
  const urls = {};
  try {
    urls.preview = await createGetUrl(storagePath, { download: false });
    urls.download = await createGetUrl(storagePath, { download: true, filename: originalName });
  } catch (err) {
    console.error('[jobs] presign failed:', err.message);
  }
  return urls;
}

export function createApp() {
  const app = express();

  // CORS: set CORS_ORIGIN to a comma-separated allowlist in production
  // (e.g. https://cusheetgenerator.com,https://www.cusheetgenerator.com).
  // When set, also dynamically accepts any origin whose hostname ends with
  // the same base domain (covers Vercel preview URLs, www, etc.).
  const corsOrigin = process.env.CORS_ORIGIN;
  const allowedOrigins = corsOrigin
    ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  app.use(cors({
    origin(origin, callback) {
      // Requests without Origin (same-origin, mobile apps, curl) are always OK.
      if (!origin) return callback(null, true);
      // No allowlist configured → open CORS (dev mode).
      if (allowedOrigins.length === 0) return callback(null, true);
      // Exact match in the allowlist.
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Dynamic check: allow any subdomain of the first allowed origin's
      // base domain (e.g. https://preview-abc.vercel.app if the allowlist
      // contains https://cusheetgenerator.com → same base host pattern).
      try {
        const hostname = new URL(origin).hostname;
        const baseHost = new URL(allowedOrigins[0]).hostname;
        // Allow www/non-www variants and Vercel preview subdomains
        if (
          hostname === baseHost
          || hostname === `www.${baseHost}`
          || hostname.endsWith(`.${baseHost}`)
        ) {
          return callback(null, true);
        }
      } catch { /* malformed origin */ }
      console.warn(`[cors] Blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    },
  }));
  app.use(express.json());

  // ---- Root & health check ----
  app.get('/', (req, res) => {
    res.json({ ok: true, service: 'print-shop-api', jobs: '/api/jobs', health: '/health' });
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // ---- Jobs API ----

  app.get('/api/jobs', async (req, res) => {
    let jobs = await listJobs();
    // Auto-cleanup first, then drop whatever was purged from the served list.
    const purged = await purgeExpiredJobs();
    if (purged.length) jobs = jobs.filter((j) => !purged.includes(j.id));
    // Completed orders past the 30h pickup window live in the bin, not here.
    jobs = jobs.filter((j) => !isBinned(j));
    // Not-yet-due scheduled prints stay hidden until their scheduled time.
    jobs = jobs.filter((j) => !isScheduledFuture(j));
    // Per-shop queue: when the dashboard passes its shopId, only orders sent
    // to THAT shop are returned. No filter → everything (used by the pickup-
    // code generators on the site, which need the global list).
    const shopId = String(req.query.shopId || '').trim();
    if (shopId) jobs = jobs.filter((j) => j.shopId === shopId);
    const out = await Promise.all(jobs.map(async (job) => {
      const urls = await presignUrls(job.storagePath, job.originalName);
      return jobToApi(job, urls);
    }));
    res.json(out);
  });

  // Lightweight metadata list for the dashboard's 5-second silent polling.
  // No presigned R2 URLs are generated here — the shop owner only fetches the
  // actual file when they explicitly preview/download/print an order. When
  // `since` is given (an ISO timestamp from a previous poll's serverTime), only
  // orders created or updated after it are returned, so repeated polls stay
  // incremental and cheap. The response carries its own serverTime so the
  // client tracks the checkpoint on the server's clock (no clock-skew drift).
  app.get('/api/jobs/meta', async (req, res) => {
    // Capture the checkpoint BEFORE reading/filtering: any order created after
    // this instant is guaranteed to be picked up by the NEXT poll, so nothing
    // can fall through the cracks between polls.
    const serverTime = new Date().toISOString();
    let jobs = await listJobs();
    // Auto-cleanup first, then drop whatever was purged from the served list.
    const purged = await purgeExpiredJobs();
    if (purged.length) jobs = jobs.filter((j) => !purged.includes(j.id));
    // Completed orders past the 30h pickup window live in the bin, not here.
    jobs = jobs.filter((j) => !isBinned(j));
    // Not-yet-due scheduled prints stay hidden until their scheduled time.
    jobs = jobs.filter((j) => !isScheduledFuture(j));
    // Per-shop queue: only this shop's orders, so each owner sees exactly the
    // files customers sent to their shop (and never another shop's queue).
    const shopId = String(req.query.shopId || '').trim();
    if (shopId) jobs = jobs.filter((j) => j.shopId === shopId);
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    if (since && !Number.isNaN(since.getTime())) {
      jobs = jobs.filter((j) => {
        const created = j.createdAt ? new Date(j.createdAt) : null;
        const updated = j.updatedAt ? new Date(j.updatedAt) : null;
        // A scheduled order becomes VISIBLE to the owner at scheduledFor — but
        // its created/updated timestamps are from when the order was placed, so
        // the plain since-check would drop it forever on the incremental poll.
        // Include it once, the moment its scheduled time passes: scheduledFor
        // acts as that job's "appeared" timestamp (the next poll's checkpoint
        // will already be past it, so it isn't re-sent).
        const appeared = j.scheduledFor ? new Date(j.scheduledFor) : null;
        return (created && created.getTime() > since.getTime())
          || (updated && updated.getTime() > since.getTime())
          || (appeared && Number.isFinite(appeared.getTime()) && appeared.getTime() > since.getTime());
      });
    }
    res.json({ serverTime, jobs: jobs.map(jobToMeta) });
  });

  // ---- Customer wallet ----

  // Wallet balance + transaction history for the logged-in customer.
  // Auto-creates the wallet with the testing default balance (₹1,00,000).
  app.get('/api/wallet', async (req, res) => {
    const uid = String(req.query.uid || '').trim();
    const email = String(req.query.email || '').trim();
    if (!uid) return res.status(400).json({ error: 'uid is required' });
    res.json(await getWallet(uid, email));
  });

  // Top up via UPI QR — minimum ₹10. `reference` is the UPI transaction id
  // from the customer's payment app (deduped, so one payment credits once).
  app.post('/api/wallet/topup', async (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const amount = Math.round(Number(req.body?.amount));
    const reference = String(req.body?.reference || '').trim();
    if (!uid) return res.status(400).json({ error: 'uid is required' });
    if (!Number.isFinite(amount) || amount < 10) {
      return res.status(400).json({ error: 'Minimum top-up is ₹10' });
    }
    if (!reference) return res.status(400).json({ error: 'UPI transaction reference is required' });
    const wallet = await getWallet(uid);
    if (wallet.transactions.some((t) => t.type === 'topup' && t.reference === reference)) {
      return res.status(409).json({ error: 'This UPI reference has already been credited' });
    }
    res.json(await credit(uid, amount, { type: 'topup', reference, note: `UPI top-up ₹${amount}` }));
  });

  // Charge the wallet for a print order — called by the site BEFORE the files
  // upload, so an order with no balance is rejected before anything is sent.
  app.post('/api/wallet/debit', async (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const amount = Math.round(Number(req.body?.amount));
    const orderId = String(req.body?.orderId || '').trim();
    const note = String(req.body?.note || '').trim().slice(0, 300);
    if (!uid) return res.status(400).json({ error: 'uid is required' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const result = await debitWallet(uid, amount, { orderId: orderId || undefined, note });
    if (result.error === 'insufficient_balance') {
      return res.status(402).json({
        error: 'insufficient_balance',
        message: `Not enough wallet balance — this order costs ${result.needed} points but you have ${result.balance}. Add money to your wallet first.`,
        balance: result.balance,
        needed: result.needed,
      });
    }
    if (result.error === 'already_charged') {
      return res.status(409).json({ error: 'already_charged', message: 'This order was already charged to your wallet.' });
    }
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result.wallet);
  });

  // Reverse a wallet charge when the upload failed before any job was created.
  app.post('/api/wallet/refund', async (req, res) => {
    const uid = String(req.body?.uid || '').trim();
    const orderId = String(req.body?.orderId || '').trim();
    if (!uid || !orderId) return res.status(400).json({ error: 'uid and orderId are required' });
    const result = await refundWallet(uid, orderId);
    if (result.error) return res.status(404).json({ error: result.error });
    res.json(result.wallet);
  });

  // Customer order history — the logged-in customer's orders on the site's
  // "My Orders" page. Matches by the email/uid the site records when the
  // order is placed. Metadata only (no presigned file URLs).
  app.get('/api/jobs/mine', async (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    const uid = String(req.query.uid || '').trim();
    if (!email && !uid) {
      return res.status(400).json({ error: 'email or uid is required' });
    }
    const jobs = await listJobs();
    const mine = jobs.filter((j) => {
      if (uid && j.customerUid && j.customerUid === uid) return true;
      if (email && j.customerEmail && String(j.customerEmail).toLowerCase() === email) return true;
      return false;
    });
    res.json({ serverTime: new Date().toISOString(), jobs: mine.map(jobToMeta) });
  });

  // Public order-status lookup — the customer enters their 4-digit pickup code
  // on the site's Track Order page. Metadata only (no presigned file URLs).
  app.get('/api/jobs/by-code/:orderCode', async (req, res) => {
    const code = String(req.params.orderCode || '').trim();
    if (!/^\d{4}$/.test(code)) {
      return res.status(400).json({ error: 'orderCode must be exactly 4 digits' });
    }
    const jobs = await listJobs();
    const job = jobs.find((j) => j.orderCode === code);
    if (!job) return res.status(404).json({ error: 'Order not found' });
    res.json(jobToMeta(job));
  });

  // Completed orders in the 30–36h bin — hidden from the active queue but
  // still visible to the owner (who can restore or print them) until the
  // permanent delete at 36h.
  app.get('/api/jobs/bin', async (req, res) => {
    let jobs = await listJobs();
    const purged = await purgeExpiredJobs();
    if (purged.length) jobs = jobs.filter((j) => !purged.includes(j.id));
    const shopId = String(req.query.shopId || '').trim();
    if (shopId) jobs = jobs.filter((j) => j.shopId === shopId);
    res.json({ serverTime: new Date().toISOString(), jobs: jobs.filter(isBinned).map(jobToMeta) });
  });

  app.get('/api/jobs/:id', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const urls = await presignUrls(job.storagePath, job.originalName);
    res.json(jobToApi(job, urls));
  });

  // Step 1 of upload: server picks the R2 key and returns a presigned PUT URL
  // so the browser uploads the file straight to R2 (serverless functions
  // don't accept large request bodies).
  app.post('/api/jobs/upload-url', async (req, res) => {
    const originalName = String(req.body?.originalName || '').trim();
    if (!originalName) return res.status(400).json({ error: 'originalName is required' });

    const ext = path.extname(originalName).toLowerCase();
    const rawExt = ext.slice(1);
    if (rawExt && !ALLOWED_EXTENSIONS.has(rawExt)) {
      return res.status(400).json({ error: `Unsupported file type ".${rawExt}". Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` });
    }
    const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : '';
    const storagePath = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`;

    const signedUrl = await createUploadUrl(storagePath, req.body?.mimeType || '');
    res.json({ signedUrl, path: storagePath, originalName });
  });

  // Step 2 of upload: record the job after the browser has PUT the file to R2.
  app.post('/api/jobs', async (req, res) => {
    // Cheap opportunistic cleanup — a new order is a natural moment to sweep
    // expired completed orders (only runs on writes, never blocks the read
    // path or the polling loop).
    try { await purgeExpiredJobs(); } catch { /* best effort */ }
    const storagePath = String(req.body?.path || '').trim();
    const originalName = String(req.body?.originalName || '').trim();
    if (!storagePath || !originalName) {
      return res.status(400).json({ error: 'path and originalName are required' });
    }    // 4-digit pickup code — the customer shows this at the shop to collect
    // their printout. The site passes ONE code for the whole order; every file
    // in that order shares it via the same `orderId`, so a multi-file order
    // doesn't collide with itself. Jobs created without a code (e.g. from the
    // dashboard's "New job" form) get a fresh server-generated code. Codes are
    // unique per ACTIVE order — two different customers can never match the
    // same code (an active job owned by another order rejects the code).
    // Scheduled prints: the customer picks a future time; the job is hidden
    // from the owner's queue until then. The file uploads right away, so it's
    // ready when the time arrives.
    const scheduledRaw = String(req.body?.scheduledFor || '').trim();
    const scheduledDate = scheduledRaw ? new Date(scheduledRaw) : null;
    const scheduledFor = (scheduledDate && !Number.isNaN(scheduledDate.getTime()))
      ? scheduledDate.toISOString()
      : null;
    const orderId = String(req.body?.orderId || '').trim().slice(0, 100) || null;
    let orderCode = String(req.body?.orderCode || '').trim();
    if (orderCode && !/^\d{4}$/.test(orderCode)) {
      return res.status(400).json({ error: 'orderCode must be exactly 4 digits' });
    }
    const active = await listJobs();
    const codeOwners = new Map(); // orderCode → owning orderId (null when unknown)
    active.forEach((j) => {
      if (j.status !== 'completed' && j.orderCode && !codeOwners.has(j.orderCode)) {
        codeOwners.set(j.orderCode, j.orderId || null);
      }
    });
    // A code is free when it's unused OR already owned by THIS order (the
    // order's 2nd+ file shares it) — only codes owned by ANOTHER order block.
    const codeIsFree = (code) => {
      if (!codeOwners.has(code)) return true;
      const owner = codeOwners.get(code);
      return !!(orderId && owner && owner === orderId);
    };
    if (orderCode && !codeIsFree(orderCode)) {
      return res.status(409).json({ error: 'orderCode_taken', message: 'Pickup code in use — please try again.' });
    }
    while (!orderCode || !codeIsFree(orderCode)) {
      orderCode = randomOrderCode();
    }

    const job = await addJob({
      storagePath,
      originalName,
      mimeType: req.body?.mimeType ? String(req.body.mimeType).slice(0, 200) : '',
      size: Number(req.body?.size) || 0,
      customerName: String(req.body?.customerName || '').trim().slice(0, 200),
      notes: String(req.body?.notes || '').trim().slice(0, 2000),
      // Customer identity (Firebase) — lets the site's "My Orders" page list
      // every order this customer has placed.
      customerEmail: String(req.body?.customerEmail || '').trim().toLowerCase().slice(0, 320) || null,
      customerUid: String(req.body?.customerUid || '').trim().slice(0, 128) || null,
      orderId,
      orderCode,
      // Registered shop this order goes to (the customer picked it on the site).
      shopId: String(req.body?.shopId || '').trim().slice(0, 128) || null,
      shopName: String(req.body?.shopName || '').trim().slice(0, 100) || null,
      // Colour print — the customer toggled Colour on the site; the shop
      // dashboard shows a 🌈 badge so the owner knows before printing.
      color: req.body?.color ? true : false,
      // Future-scheduled print — hidden from the owner's queue until this time.
      scheduledFor,
      status: 'new',
    });
    const urls = await presignUrls(storagePath, originalName);
    res.status(201).json(jobToApi(job, urls));
  });

  app.patch('/api/jobs/:id', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const updates = {};
    if (typeof req.body?.status === 'string') {
      if (!STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
      }
      updates.status = req.body.status;
    }
    if (typeof req.body?.customerName === 'string') updates.customerName = req.body.customerName.trim().slice(0, 200);
    if (typeof req.body?.notes === 'string') updates.notes = req.body.notes.trim().slice(0, 2000);
    // Colour / black & white — the shop owner can flip the print mode.
    if (typeof req.body?.color === 'boolean') updates.color = req.body.color;

    // Restore a binned (30–36h) completed order — updateJob stamps a fresh
    // updatedAt, so it gets a new 30h window in the active queue instead of
    // being permanently deleted at 36h.
    if (req.body?.restore === true) {
      if (job.status !== 'completed') {
        return res.status(400).json({ error: 'Only completed orders can be restored.' });
      }
      if (job.fileDeletedAt) {
        return res.status(409).json({ error: 'This order’s file was already deleted after the 36-hour window — only its data remains.' });
      }
      updates.status = 'completed';
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

    const updated = await updateJob(req.params.id, updates);
    const urls = await presignUrls(updated.storagePath, updated.originalName);
    res.json(jobToApi(updated, urls));
  });

  app.delete('/api/jobs/:id', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    // Completed orders are permanent records — they stay counted in the
    // dashboard's "Completed" total and must never be deleted.
    if (job.status === 'completed') {
      return res.status(409).json({ error: 'Completed orders cannot be deleted.' });
    }
    await deleteJobRecord(job.id);
    try {
      await deleteObject(job.storagePath);
    } catch (err) {
      console.error('[jobs] R2 delete failed:', err.message);
    }
    res.status(204).end();
  });

  // ---- Reviews API ----
  // Each rating from the site's post-download popup is stored as one small JSON
  // object in the R2 "reviews" bucket (reviews/<timestamp>-<id>.json), so the
  // owner can browse them in the R2 console. GET recomputes the stats for the
  // public /reviews page.
  const REVIEW_COMMENT_MAX = 500;
  const REVIEWS_LIST_CAP = 500;

  // Save one anonymous review (rating 1–5 + optional comment) to the reviews bucket.
  app.post('/api/reviews', async (req, res) => {
    const rating = Math.round(Number(req.body?.rating));
    const comment = String(req.body?.comment || '').trim().slice(0, REVIEW_COMMENT_MAX);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be a whole number between 1 and 5' });
    }
    const key = `reviews/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.json`;
    const record = {
      rating,
      comment: comment || null,
      createdAt: new Date().toISOString(),
      source: 'download-prompt',
    };
    try {
      await putJsonObject(REVIEWS_BUCKET, key, record);
      res.status(201).json({ ok: true, id: key });
    } catch (err) {
      console.error('[reviews] save failed:', err.message);
      res.status(500).json({ error: 'Could not save review.' });
    }
  });

  // Stored reviews + computed stats for the public /reviews page: total count,
  // average rating and the newest reviews (capped at 500, same as the old SQL
  // path so the per-star distribution reflects the same data as the total).
  app.get('/api/reviews', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query?.limit) || REVIEWS_LIST_CAP, 1), REVIEWS_LIST_CAP);
    try {
      const objs = await listObjects(REVIEWS_BUCKET, 'reviews/');
      const all = [];
      for (const o of objs) {
        const data = await getJsonObject(REVIEWS_BUCKET, o.Key);
        const rating = Math.round(Number(data && data.rating));
        if (!data || !Number.isInteger(rating) || rating < 1 || rating > 5) continue;
        all.push({
          id: o.Key,
          rating,
          comment: data.comment || '',
          created_at: data.createdAt || null,
        });
      }
      // Newest first (keys are timestamp-prefixed).
      all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
      const count = all.length;
      const average = count ? all.reduce((sum, r) => sum + r.rating, 0) / count : 0;
      res.json({ count, average, reviews: all.slice(0, limit) });
    } catch (err) {
      console.error('[reviews] list failed:', err.message);
      res.status(500).json({ error: 'Could not load reviews.' });
    }
  });

  // ---- Shops API ----

  // The 6-digit PIN a shop owner must enter (once, during setup) to register
  // their shop. Lives only on the server — the client never sees it, and the
  // dashboard verifies it here, never in the browser.
  const SHOP_SETUP_PIN = String(process.env.SHOP_SETUP_PIN || '542004').trim();

  // The shop registered to the signed-in owner, or { shop: null }.
  app.get('/api/shops/mine', async (req, res) => {
    const ownerUid = String(req.query.uid || '').trim();
    const ownerEmail = String(req.query.email || '').trim();
    if (!ownerUid) return res.status(400).json({ error: 'uid is required' });
    const shop = await getShopByOwner(ownerUid);
    res.json({ shop });
  });

  // Public list of registered shops — the customer site shows these as the
  // "Nearby print shops" when placing an order.
  app.get('/api/shops', async (req, res) => {
    const shops = await listShops();
    res.json({ shops: shops.map((s) => ({ id: s.id, name: s.name, createdAt: s.createdAt })) });
  });

  // Public HTML page listing registered shops — can be embedded via iframe
  // or linked from the customer site so customers see real registered shops
  // instead of any hardcoded placeholder data.
  app.get('/shops', async (req, res) => {
    const shops = await listShops();
    const shopCards = shops.map((s) => `
      <div class="shop-card">
        <div class="shop-icon">🖨️</div>
        <h3>${String(s.name).replace(/[<>"&]/g, '')}</h3>
        <button onclick="window.open('https://cusheetgenerator.com/send-to-print?shopId=${s.id}','_blank')">Order here</button>
      </div>`).join('\n');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nearby Print Shops</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; padding: 24px; }
  h2 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin-bottom: 16px; }
  .shops { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
  .shop-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; text-align: center; }
  .shop-icon { font-size: 28px; margin-bottom: 8px; }
  .shop-card h3 { font-size: 16px; font-weight: 700; margin-bottom: 12px; }
  .shop-card button { width: 100%; padding: 10px; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .shop-card button:hover { background: #1d4ed8; }
  .empty { color: #9ca3af; text-align: center; padding: 40px; font-size: 14px; }
</style></head><body>
<h2>Nearby Print Shops</h2>
<div class="shops">
${shopCards || '<div class="empty">No registered print shops yet.</div>'}
</div></body></html>`;
    res.type('html').send(html);
  });

  // Delete a registered shop by owner UID (admin/test cleanup).
  app.post('/api/shops/delete', async (req, res) => {
    const ownerUid = String(req.body?.id || '').trim();
    if (!ownerUid) return res.status(400).json({ error: 'id is required' });
    const existing = await getShopByOwner(ownerUid);
    if (!existing) return res.status(404).json({ error: 'Shop not found' });
    await deleteShop(ownerUid);
    res.json({ ok: true, deleted: ownerUid });
  });

  // Register the owner's shop — the ONE place the setup PIN is checked.
  // Body: { uid, email, name, pin }. The PIN is server-verified (env
  // SHOP_SETUP_PIN, default 542004); the shop is keyed by the owner's Firebase
  // UID, so one owner can never register two shops.
  app.post('/api/shops/setup', async (req, res) => {
    const ownerUid = String(req.body?.uid || '').trim();
    const ownerEmail = String(req.body?.email || '').trim();
    const name = String(req.body?.name || '').trim().slice(0, 100);
    const pin = String(req.body?.pin || '').trim();

    if (!ownerUid) return res.status(400).json({ error: 'uid is required' });
    if (!name) return res.status(400).json({ error: 'Shop name is required' });
    if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits' });
    if (pin !== SHOP_SETUP_PIN) return res.status(403).json({ error: 'Invalid PIN — please check with the platform owner.' });

    const existing = await getShopByOwner(ownerUid);
    if (existing) return res.status(409).json({ error: 'This owner already has a shop registered.', shop: existing });

    const shop = await createShop({ ownerUid, ownerEmail, name });
    res.status(201).json({ shop });
  });

  // ---- Error handling ----
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

// Default-export the app instance so Vercel's Express framework preset can
// serve it as the root function (in addition to the explicit api/index entry).
export default createApp();
