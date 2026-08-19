// Render entry point — loads .env, ensures the R2 bucket, starts Express.
import './env.js';
import { createApp } from './app.js';
import { ensureBucket } from './r2.js';
import { setup } from './setup.js';

const PORT = process.env.PORT || 10000;

async function start() {
  // Idempotent — creates the R2 bucket on first cold start if missing.
  await ensureBucket().catch((err) => {
    console.error('[render] ensureBucket failed:', err.message);
  });

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`CuPrint API running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
