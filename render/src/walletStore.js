import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET } from './r2.js';

// Customer wallets live in Cloudflare R2 alongside the print jobs — one JSON
// object per user, so no separate database is needed:
//   • wallet records → <bucket>/wallets/<uid>.json
//
// Balance is in points (₹1 = 1 point). The default balance is ₹1,00,000 so the
// whole flow can be tried without a payment provider (set WALLET_DEFAULT_BALANCE
// to 0 when real payments go live).
const WALLETS_PREFIX = 'wallets/';
const DEFAULT_BALANCE = Number(process.env.WALLET_DEFAULT_BALANCE) || 100000;

const walletKey = (uid) => `${WALLETS_PREFIX}${uid}.json`;

async function readWallet(uid) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: walletKey(uid) }));
    const text = await res.Body.transformToString();
    return JSON.parse(text);
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function writeWallet(wallet) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: walletKey(wallet.uid),
    Body: JSON.stringify(wallet),
    ContentType: 'application/json',
  }));
}

/** The wallet for a user, created on first access with the default balance. */
export async function getWallet(uid, email) {
  let wallet = await readWallet(uid);
  if (!wallet) {
    wallet = { uid, email: email || '', balance: DEFAULT_BALANCE, transactions: [] };
    await writeWallet(wallet);
    return wallet;
  }
  if (email && wallet.email !== email) {
    wallet.email = email;
    await writeWallet(wallet);
  }
  return wallet;
}

/** Add points (top-up / refund). `tx` is spread into the transaction record. */
export async function credit(uid, amount, tx) {
  const wallet = await getWallet(uid);
  wallet.balance += amount;
  wallet.transactions.push({ id: randomUUID(), amount, createdAt: new Date().toISOString(), ...tx });
  await writeWallet(wallet);
  return wallet;
}

/**
 * Charge the wallet. Returns { wallet } on success, or
 * { error: 'insufficient_balance', balance, needed } / { error: 'already_charged' }.
 * Each orderId is charged at most once, so a multi-file order never double-charges.
 */
export async function debitWallet(uid, amount, tx) {
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'amount_must_be_positive' };
  const wallet = await getWallet(uid);
  if (tx.orderId && wallet.transactions.some((t) => t.type === 'debit' && t.orderId === tx.orderId)) {
    return { error: 'already_charged' };
  }
  if (wallet.balance < amount) {
    return { error: 'insufficient_balance', balance: wallet.balance, needed: amount };
  }
  wallet.balance -= amount;
  wallet.transactions.push({
    id: randomUUID(),
    type: 'debit',
    amount: -amount,
    createdAt: new Date().toISOString(),
    ...tx,
  });
  await writeWallet(wallet);
  return { wallet };
}

/** Reverse a debit for an order that failed before any job was created. */
export async function refund(uid, orderId) {
  const wallet = await getWallet(uid);
  const debit = wallet.transactions.find((t) => t.type === 'debit' && t.orderId === orderId);
  if (!debit) return { error: 'no_debit_found' };
  const back = Math.abs(debit.amount);
  wallet.balance += back;
  wallet.transactions.push({
    id: randomUUID(),
    type: 'refund',
    amount: back,
    orderId,
    note: `Refund for cancelled order ${orderId}`,
    createdAt: new Date().toISOString(),
  });
  await writeWallet(wallet);
  return { wallet };
}
