import '../src/env.js';
import { createApp } from '../src/app.js';
import { ensureBucket } from '../src/r2.js';

// Idempotent — creates the R2 bucket on first cold start if missing.
ensureBucket().catch((err) => {
  console.error('[vercel] ensureBucket failed:', err.message);
});

export default createApp();
