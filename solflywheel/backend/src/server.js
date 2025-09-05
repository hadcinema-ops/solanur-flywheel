import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  clusterApiUrl,
  TransactionMessage
} from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import axios from 'axios';
import {
  getAssociatedTokenAddress,
  getMint,
  createTransferCheckedInstruction,
  createBurnCheckedInstruction,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction
} from '@solana/spl-token';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config ----------
const RPC_URL = process.env.RPC_URL || clusterApiUrl('mainnet-beta');
const TARGET_MINT = new PublicKey(process.env.TARGET_MINT);
const ALLOWED_PUBKEY = new PublicKey(process.env.ALLOWED_PUBKEY);
const PORT = parseInt(process.env.PORT || '8787', 10);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:8080';

const DEV_WALLET_KEYPAIR_PATH = process.env.DEV_WALLET_KEYPAIR;
const DEV_WALLET_SECRET_KEY = process.env.DEV_WALLET_SECRET_KEY;

const FEE_RESERVE_SOL = parseFloat(process.env.FEE_RESERVE_SOL || '0.05');
const MIN_SPEND_SOL = parseFloat(process.env.MIN_SPEND_SOL || '0.05');
const MAX_SPEND_SOL = parseFloat(process.env.MAX_SPEND_SOL || '2');

const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '100', 10);
const BURN_MODE = (process.env.BURN_MODE || 'burn').toLowerCase(); // 'burn' | 'incinerate'

const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');
const JUP_BASE = process.env.JUPITER_BASE_URL || 'https://quote-api.jup.ag';

// ---------- State & Helpers ----------
const connection = new Connection(RPC_URL, { commitment: 'confirmed' });

function loadKeypair() {
  if (DEV_WALLET_KEYPAIR_PATH && fs.existsSync(DEV_WALLET_KEYPAIR_PATH)) {
    const data = JSON.parse(fs.readFileSync(DEV_WALLET_KEYPAIR_PATH, 'utf8'));
    return Keypair.fromSecretKey(Uint8Array.from(data));
  }
  if (DEV_WALLET_SECRET_KEY) {
    const secret = bs58.decode(DEV_WALLET_SECRET_KEY);
    return Keypair.fromSecretKey(secret);
  }
  throw new Error('No DEV_WALLET_KEYPAIR or DEV_WALLET_SECRET_KEY found');
}
const devKeypair = loadKeypair();
if (devKeypair.publicKey.toBase58() !== ALLOWED_PUBKEY.toBase58()) {
  console.warn('WARNING: Dev keypair pubkey does not match ALLOWED_PUBKEY');
}

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const metricsPath = path.join(dataDir, 'metrics.json');

const defaultMetrics = {
  running: false,
  lastRunAt: null,
  totals: { solSpent: 0, tokensBoughtRaw: '0', tokensBurnedRaw: '0' },
  history: []
};

function loadMetrics() {
  if (fs.existsSync(metricsPath)) return JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  return defaultMetrics;
}
function saveMetrics(m) { fs.writeFileSync(metricsPath, JSON.stringify(m, null, 2)); }
let metrics = loadMetrics();

function toLamports(sol) { return Math.floor(sol * LAMPORTS_PER_SOL); }

async function getSolBalance(pubkey) {
  return await connection.getBalance(pubkey, { commitment: 'processed' });
}

async function jupSwapSOLToToken(amountLamports) {
  // 1) Quote
  const inputMint = 'So11111111111111111111111111111111111111112';
  const outputMint = TARGET_MINT.toBase58();
  const quoteUrl = `${JUP_BASE}/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${SLIPPAGE_BPS}`;
  const quote = (await axios.get(quoteUrl)).data;
  if (!quote || !quote.routePlan) throw new Error('Jupiter quote failed');

  // 2) Swap transaction
  const swapBody = {
    quoteResponse: quote,
    userPublicKey: devKeypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 0
  };
  const swapRes = await axios.post(`${JUP_BASE}/v6/swap`, swapBody, { headers: { 'Content-Type': 'application/json' } });
  const { swapTransaction } = swapRes.data;
  if (!swapTransaction) throw new Error('No swapTransaction from Jupiter');

  // 3) Sign & send
  const rawTx = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(rawTx);
  tx.sign([devKeypair]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await connection.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) throw new Error(`Swap TX failed: ${sig}`);
  return sig;
}

async function getMintAndATA(owner, mintPk) {
  const mintInfo = await getMint(connection, mintPk);
  const ata = await getAssociatedTokenAddress(mintPk, owner, false);
  return { mintInfo, ata };
}

async function getTokenBalanceRaw(ata) {
  const ai = await connection.getTokenAccountBalance(ata).catch(() => null);
  return ai?.value?.amount || '0';
}

async function burnAllFromATA(payer, owner, mintPk, ata, decimals) {
  const raw = await getTokenBalanceRaw(ata);
  if (raw === '0') return { burnedRaw: '0', sig: null };

  const amountBN = BigInt(raw);
  const ix = createBurnCheckedInstruction(ata, mintPk, owner, amountBN, decimals, [], TOKEN_PROGRAM_ID);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message()
  );
  tx.sign([payer]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error(`Burn failed: ${sig}`);
  return { burnedRaw: raw, sig };
}

async function sendAllToIncinerator(payer, owner, mintPk, fromAta, decimals) {
  const raw = await getTokenBalanceRaw(fromAta);
  if (raw === '0') return { sentRaw: '0', sig: null };

  const incinerator = INCINERATOR;
  const incineratorAta = await getAssociatedTokenAddress(mintPk, incinerator, true);

  const ixs = [];
  const incataInfo = await connection.getAccountInfo(incineratorAta);
  if (!incataInfo) {
    ixs.push(createAssociatedTokenAccountInstruction(payer.publicKey, incineratorAta, incinerator, mintPk));
  }

  const amt = BigInt(raw);
  ixs.push(createTransferCheckedInstruction(fromAta, mintPk, incineratorAta, owner, amt, decimals));

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message()
  );
  tx.sign([payer]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error(`Incinerate transfer failed: ${sig}`);
  return { sentRaw: raw, sig };
}

// ---------- Flywheel core ----------
async function runOnce() {
  const now = new Date().toISOString();
  console.log(`[${now}] Flywheel tick`);

  const balLamports = await getSolBalance(devKeypair.publicKey);
  const reserveLamports = Math.floor(FEE_RESERVE_SOL * LAMPORTS_PER_SOL);
  let spendLamports = balLamports - reserveLamports;
  spendLamports = Math.min(spendLamports, Math.floor(MAX_SPEND_SOL * LAMPORTS_PER_SOL));
  if (spendLamports < Math.floor(MIN_SPEND_SOL * LAMPORTS_PER_SOL)) {
    console.log(' - Skip: balance under reserve + min.');
    return;
  }

  const swapSig = await jupSwapSOLToToken(spendLamports);
  console.log(' - Swap sig:', swapSig);

  const { mintInfo, ata } = await getMintAndATA(devKeypair.publicKey, TARGET_MINT);
  const decimals = mintInfo.decimals;

  await new Promise(r => setTimeout(r, 2500));
  const boughtRaw = await getTokenBalanceRaw(ata);

  let actionSig = null;
  let deltaRaw = '0';
  if (BURN_MODE === 'incinerate') {
    const { sentRaw, sig } = await sendAllToIncinerator(devKeypair, devKeypair.publicKey, TARGET_MINT, ata, decimals);
    deltaRaw = sentRaw; actionSig = sig;
  } else {
    const { burnedRaw, sig } = await burnAllFromATA(devKeypair, devKeypair.publicKey, TARGET_MINT, ata, decimals);
    deltaRaw = burnedRaw; actionSig = sig;
  }

  // Update metrics
  metrics.totals.solSpent += spendLamports / LAMPORTS_PER_SOL;
  metrics.totals.tokensBoughtRaw = (BigInt(metrics.totals.tokensBoughtRaw || '0') + BigInt(boughtRaw)).toString();
  metrics.totals.tokensBurnedRaw = (BigInt(metrics.totals.tokensBurnedRaw || '0') + BigInt(deltaRaw)).toString();
  metrics.history.unshift({
    time: now,
    solUsed: spendLamports / LAMPORTS_PER_SOL,
    tokensBoughtRaw: boughtRaw,
    tokensBurnedRaw: deltaRaw,
    swapTx: swapSig,
    actionTx: actionSig,
    mode: BURN_MODE,
  });
  metrics.history = metrics.history.slice(0, 100);
  metrics.lastRunAt = now;
  saveMetrics(metrics);
}

// ---------- API Server ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: FRONTEND_ORIGIN.split(',').map(s => s.trim()),
  credentials: true
}));

// Public endpoints
app.get('/api/public/metrics', (_, res) => res.json(metrics));
app.get('/api/public/status', (_, res) => res.json({ running: metrics.running, lastRunAt: metrics.lastRunAt }));
app.get('/healthz', (_, res) => res.send('ok'));

// Admin endpoints (dev wallet only; signed message)
function verifySig(pubkeyBase58, message, signatureBase58) {
  const pub = new PublicKey(pubkeyBase58);
  const sig = bs58.decode(signatureBase58);
  const msg = new TextEncoder().encode(message);
  return nacl.sign.detached.verify(msg, sig, pub.toBytes());
}

app.post('/api/admin/start', (req, res) => {
  try {
    const { pubkey, message, signature } = req.body || {};
    if (!pubkey || !message || !signature) return res.status(400).json({ error: 'Missing fields' });
    if (new PublicKey(pubkey).toBase58() !== ALLOWED_PUBKEY.toBase58()) return res.status(403).json({ error: 'Not allowed' });
    if (!verifySig(pubkey, message, signature)) return res.status(400).json({ error: 'Bad signature' });
    metrics.running = true; saveMetrics(metrics);
    res.json({ ok: true, running: metrics.running });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal error' }); }
});
app.post('/api/admin/stop', (req, res) => {
  try {
    const { pubkey, message, signature } = req.body || {};
    if (!pubkey || !message || !signature) return res.status(400).json({ error: 'Missing fields' });
    if (new PublicKey(pubkey).toBase58() !== ALLOWED_PUBKEY.toBase58()) return res.status(403).json({ error: 'Not allowed' });
    if (!verifySig(pubkey, message, signature)) return res.status(400).json({ error: 'Bad signature' });
    metrics.running = false; saveMetrics(metrics);
    res.json({ ok: true, running: metrics.running });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal error' }); }
});

app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));

// Internal scheduler
cron.schedule('*/20 * * * *', async () => {
  if (!metrics.running) return;
  try { await runOnce(); } catch (e) { console.error('Flywheel error:', e.message || e); }
});
