import { s3, BUCKET, hasCredentials as r2Ready } from './r2.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { addJob, listJobs } from './store.js';
import { makePng } from './png.js';
import { makePdf } from './pdf.js';

/**
 * Seed a few demo print jobs (with real, generated files) the first time the
 * server runs against an empty print_jobs store so the dashboard isn't empty.
 * Set DEMO_FILES=0 to disable.
 */
export async function seedDemoJobs() {
  if (process.env.DEMO_FILES === '0') return;
  if (!r2Ready) {
    console.warn('[seed] Skipped — Cloudflare R2 credentials not configured.');
    return;
  }

  const existing = await listJobs();
  if (existing.length) return;

  const stamp = Date.now();
  const upload = async (fileName, buffer, contentType) => {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: fileName,
      Body: buffer,
      ContentType: contentType,
    }));
  };

  const demos = [
    {
      make: () => makePng(640, 420, (x, y, w, h) => {
        const t = (x + y) / (w + h);
        let r = Math.round(20 + t * 150);
        let g = Math.round(90 + t * 40);
        let b = Math.round(140 + t * 100);
        const cx = w / 2;
        const cy = h / 2;
        const hw = w * 0.38;
        const hh = h * 0.34;
        const qx = Math.max(Math.abs(x - cx) - hw, 0);
        const qy = Math.max(Math.abs(y - cy) - hh, 0);
        if (Math.hypot(qx, qy) < 40) {
          r = 252;
          g = 252;
          b = 252;
        }
        return [r, g, b];
      }),
      fileName: `demo-flyer-${stamp}.png`,
      originalName: 'summer-sale-flyer.png',
      mimeType: 'image/png',
      customerName: 'Cafe Verde',
      notes: 'A5 flyer, full color, 50 copies. Due Friday.',
      orderCode: '4821',
      status: 'new',
    },
    {
      make: () => makePdf('Weekly Specials Menu', [
        'Prepared for: Bella Trattoria',
        '',
        'This is a sample PDF generated automatically so you can',
        'test the preview and download features of the dashboard.',
        '',
        'Print: A4, double-sided, 30 copies.',
      ]),
      fileName: `demo-menu-${stamp}.pdf`,
      originalName: 'weekly-specials-menu.pdf',
      mimeType: 'application/pdf',
      customerName: 'Bella Trattoria',
      notes: 'A4 double-sided, 30 copies, color.',
      orderCode: '7350',
      status: 'printing',
    },
    {
      make: () => Buffer.from(
        'RENTAL AGREEMENT\n\nThis is a plain text document uploaded to demonstrate how\nnon-image, non-PDF files (like Word documents) are handled.\n\nWord (.docx) files show a preview card with a download button.',
        'utf8',
      ),
      fileName: `demo-contract-${stamp}.txt`,
      originalName: 'rental-agreement.txt',
      mimeType: 'text/plain',
      customerName: 'City Legal',
      notes: 'Print 2 copies on letter paper.',
      orderCode: '9162',
      status: 'ready',
    },
  ];

  for (const demo of demos) {
    const buffer = demo.make();
    await upload(demo.fileName, buffer, demo.mimeType);
    await addJob({
      storagePath: demo.fileName,
      originalName: demo.originalName,
      mimeType: demo.mimeType,
      size: buffer.length,
      customerName: demo.customerName,
      notes: demo.notes,
      orderCode: demo.orderCode,
      status: demo.status,
    });
  }
  console.log(`[seed] Created ${demos.length} demo print jobs.`);
}
