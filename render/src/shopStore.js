import {
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { s3, BUCKET } from './r2.js';

// Registered print shops live in R2 under `shops/` — one JSON object per shop,
// keyed by the owner's Firebase UID so each owner can register exactly one shop:
//   • shop record → <bucket>/shops/<ownerUid>.json
// A shop exists only after the owner proves the setup PIN (server-verified);
// once registered, it shows up in the public shop list on the customer site.
const SHOPS_PREFIX = 'shops/';

const shopKey = (ownerUid) => `${SHOPS_PREFIX}${ownerUid}.json`;

async function readJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await res.Body.transformToString();
  return JSON.parse(text);
}

/** The shop owned by `ownerUid`, or null when not registered yet. */
export async function getShopByOwner(ownerUid) {
  try {
    const doc = await readJson(shopKey(ownerUid));
    return { id: doc.id, ...doc };
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** Public list of every registered shop, oldest first. */
export async function listShops() {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: SHOPS_PREFIX,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents || []) keys.push(obj.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  const shops = await Promise.all(keys.map(async (key) => {
    try {
      const doc = await readJson(key);
      return { id: doc.id, ...doc };
    } catch (err) {
      console.error('[shops] failed to read shop record:', key, err.message);
      return null;
    }
  }));
  return shops
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Register a shop for the owner. `name` is the display name shown to customers. */
export async function createShop({ ownerUid, ownerEmail, name }) {
  const shop = {
    id: ownerUid, // one shop per owner — the UID is also the shop id
    ownerUid,
    ownerEmail,
    name,
    createdAt: new Date().toISOString(),
  };
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: shopKey(ownerUid),
    Body: JSON.stringify(shop),
    ContentType: 'application/json',
  }));
  return shop;
}

/** Remove a shop (not used by the UI yet, but symmetric with the store). */
export async function deleteShop(ownerUid) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: shopKey(ownerUid) }));
}
