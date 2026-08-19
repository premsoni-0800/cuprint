# Print Shop Dashboard

A full-stack dashboard for print shop owners. Customers' files (PDFs, images, Word docs, etc.) land in a print queue where the owner can **preview**, **download**, and manage them before printing.

## Stack

- **Client** — React 19 + Vite (`client/`)
- **Server** — Node + Express 5 (`server/`)
- **Storage & database** — **Cloudflare R2** (S3-compatible). Uploaded files go
  in the bucket root, and each job record is a JSON object at `jobs/<id>.json`
  in the same bucket — no separate database service required.

## Getting started

```bash
cp .env.example .env      # then fill in your Cloudflare R2 credentials
npm install               # installs client + server (npm workspaces)
npm run dev               # starts API on :4000 and client on :5173
```

Open http://localhost:5173. On first start the server seeds three demo jobs
(sample PDF, PNG, and TXT files generated on the fly) so the dashboard isn't
empty — set `DEMO_FILES=0` to disable.

The R2 credentials come from the Cloudflare dashboard
(R2 → Manage R2 API Tokens → Create API token, Object Read & Write). The
server auto-creates the bucket if it doesn't exist yet.

## What you can do

- **New job** — upload a file (PDF, images, Word/Excel/PowerPoint, text) with a customer name and print notes
- **Preview** — images, PDFs, and text files render inline; Word/other files show an info card with a download button
- **Download** — every file can be downloaded with its original name
- **Status workflow** — move jobs through New → Printing → Ready → Completed
- **Filter & stats** — filter the queue by status; see totals, in-progress, today's jobs, and storage used

## API

| Method | Endpoint          | Description                              |
| ------ | ----------------- | ---------------------------------------- |
| GET    | `/api/jobs`       | List all jobs (newest first)             |
| GET    | `/api/jobs/:id`   | Get one job                              |
| POST   | `/api/jobs`       | Record a job (after the file is in R2)   |
| PATCH  | `/api/jobs/:id`   | Update `status`, `customerName`, `notes` |
| DELETE | `/api/jobs/:id`   | Delete a job and its file from R2        |

Uploads use a two-step flow so the browser sends the file straight to Cloudflare:
1. `POST /api/jobs/upload-url` → `{ signedUrl, path }` (presigned R2 PUT)
2. `PUT` the file to the signed URL
3. `POST /api/jobs` → record the job `{ path, originalName, mimeType, size, customerName, notes }`

Allowed types: pdf, png, jpg, jpeg, gif, webp, svg, bmp, doc, docx, txt, rtf, xls, xlsx, ppt, pptx (max 50 MB).

## Connecting your customer website

Customers can send files straight from your website to this dashboard. The
API already accepts cross-origin uploads (CORS is open in development):

```js
// 1. Ask the server for a presigned upload URL
const { signedUrl, path } = await fetch('https://api.cusheetgenerator.com/api/jobs/upload-url', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ originalName: file.name, mimeType: file.type }),
}).then((r) => r.json());

// 2. Upload the file straight to Cloudflare R2
await fetch(signedUrl, { method: 'PUT', body: file });

// 3. Record the job
await fetch('https://api.cusheetgenerator.com/api/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path, originalName: file.name, mimeType: file.type, size: file.size, customerName, notes }),
});
```

On the CuSheet customer site the same call is built into the **Send to Print**
page (`/send-to-print`), which posts to `REACT_APP_PRINT_API_URL` (default
`https://api.cusheetgenerator.com`).

## Deploying the API

1. Deploy the `server/` folder to any Node host (Render, Railway, a VPS).
2. Set the Cloudflare R2 env vars (`CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET_NAME`), plus `CORS_ORIGIN=https://cusheetgenerator.com`
   (comma-separated for multiple origins) and `DEMO_FILES=0`.
3. Point your site's `REACT_APP_PRINT_API_URL` at the deployed URL.

Files and job records both live in R2, so there is no persistent disk or
database to back up — Cloudflare handles that.

## Project structure

```
├── client/            # React + Vite dashboard
│   └── src/
│       ├── App.jsx            # layout, state, stats, filters
│       ├── api.js             # API helpers + formatting utils
│       └── components/        # JobList, UploadForm, PreviewModal, FileIcon
├── server/            # Express API
│   └── src/
│       ├── dev.js     # dotenv + local startup (setup, seed, listen)
│       ├── app.js     # routes (jobs CRUD + upload-url)
│       ├── store.js   # job records as JSON in R2 (jobs/<id>.json)
│       ├── r2.js      # S3-compatible client, presigned URLs, bucket ensure
│       ├── seed.js    # demo jobs on first run
│       ├── png.js     # tiny PNG encoder (demo seed)
│       └── pdf.js     # tiny PDF generator (demo seed)
└── package.json       # npm workspaces + `npm run dev`
```

## Notes

- Everything persists in Cloudflare R2 — swap buckets per shop later for
  multi-tenancy. The API layer is small enough to add auth (a shop password or
  per-shop token) when you're ready.
- The dashboard is single-tenant with no login. Multi-shop auth would be the
  natural next step.
