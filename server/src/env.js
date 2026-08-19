import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// MUST be imported first (before app.js / r2.js / store.js) — ESM evaluates
// imports in order, so `import './env.js'` at the top of index.js guarantees
// .env is loaded before any module reads process.env at import time.
// Tries the repo root (where .env.example lives) first, then the server
// folder, so `npm run dev` from either place picks up local creds.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const dot of [path.resolve(here, '../../.env'), path.resolve(here, '../.env')]) {
  if (dotenv.config({ path: dot, quiet: true }).error == null) break;
}
