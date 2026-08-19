// First import — loads .env before app.js / r2.js / store.js read process.env.
import './env.js';
import { createApp } from './app.js';
import { setup } from './setup.js';
import { seedDemoJobs } from './seed.js';

const PORT = process.env.PORT || 4000;

async function start() {
  await setup();
  if (process.env.DEMO_FILES !== '0') await seedDemoJobs();
  createApp().listen(PORT, () => {
    console.log(`Print shop API running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
