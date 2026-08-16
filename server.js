/**
 * server.js
 * Reads ALL config from environment variables.
 * Use .env file for local dev, Railway Variables for production.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { searchCards, closeBrowser } = require('./collectr');
const {
  addOrUpdateProduct,
  bulkAddCards,
  getManagedProducts,
  invalidateManagedProductsCache,
  setMultiplier,
  setMultiplierBulk,
  setProductQuantity,
  deleteProduct,
  deleteAllManagedProducts,
  formatShopifyError,
  hasShopifyCredentials,
  getAuthMode,
  getAuthStatus,
  ensureAccessToken,
  warnMissingShopifyScopes,
  getUsdToNzdRate,
} = require('./shopify');
const { syncAllPrices, syncProductById } = require('./sync-prices');
const buyback = require('./buyback');

function getConfig() {
  return {
    shopify: {
      store: process.env.SHOPIFY_STORE || '',
      authMode: getAuthMode(),
      apiVersion: process.env.SHOPIFY_API_VERSION || '2024-04',
    },
    sync: {
      defaultMultiplier: parseFloat(process.env.DEFAULT_MULTIPLIER || '1.0'),
      cronSchedule: process.env.CRON_SCHEDULE || '0 6 * * *',
    },
  };
}

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ── Buyback CORS ──────────────────────────────────────────────────────────────
// Only the buyback endpoints are meant to be called from the storefront
// (a different origin than this app). Every other route here stays
// same-origin-only by default — deliberately not opening CORS globally,
// since several admin routes (e.g. delete-all) have no auth beyond "is
// Shopify configured."
const BUYBACK_ALLOWED_ORIGINS = new Set([
  'https://holovault.co.nz',
  'https://www.holovault.co.nz',
  `https://${process.env.SHOPIFY_STORE || ''}`,
]);

app.use('/api/buyback', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && BUYBACK_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Lightweight in-memory rate limit for the public submit endpoint — resets
// on redeploy, which is fine; this is an abuse deterrent, not a security
// boundary (the real safeguard is that a human reviews every submission
// before any money moves).
const submitAttempts = new Map(); // ip -> [timestamps]
const SUBMIT_WINDOW_MS = 60 * 60 * 1000;
const SUBMIT_MAX_PER_WINDOW = 5;

function rateLimitBuybackSubmit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const now = Date.now();
  const attempts = (submitAttempts.get(ip) || []).filter((t) => now - t < SUBMIT_WINDOW_MS);
  if (attempts.length >= SUBMIT_MAX_PER_WINDOW) {
    return res.status(429).json({ error: 'Too many submissions from this address. Please try again later.' });
  }
  attempts.push(now);
  submitAttempts.set(ip, attempts);
  next();
}

// ── Middleware ────────────────────────────────────────────────────────────────

function requireToken(req, res, next) {
  if (!hasShopifyCredentials()) {
    return res.status(401).json({
      error:
        'Shopify credentials missing. Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (auto-refresh), or SHOPIFY_TOKEN.',
    });
  }
  next();
}

// ── API Routes ────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const { shopify } = getConfig();
  const connected = hasShopifyCredentials();
  let auth = getAuthStatus();
  if (connected) {
    try {
      await ensureAccessToken();
      auth = getAuthStatus();
    } catch (err) {
      return res.status(500).json({ connected: false, store: shopify.store, error: err.message });
    }
  }
  res.json({
    connected,
    store: shopify.store,
    authMode: shopify.authMode,
    scopes: auth.scopes,
    tokenExpiresAt: auth.expiresAt,
    tokenExpiresInHours: auth.expiresInHours,
  });
});

app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (query.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters.' });

  console.log(`[Search] Querying Collectr for: "${query}"`);
  console.log(`[Search] URL: https://app.getcollectr.com/?query=${encodeURIComponent(query)}`);

  try {
    const cards = await searchCards(query);
    console.log(`[Search] Found ${cards.length} results for "${query}"`);
    res.json({ cards });
  } catch (err) {
    console.error('[Search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Buyback ("sell your cards to us") ───────────────────────────────────────
// Public — no requireToken. Customer-facing search + submit for the buyback
// flow. Offer price is always server-computed (75% of Collectr market price)
// so a tampered client-side number can never affect what gets reviewed.

app.get('/api/buyback/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (query.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters.' });

  try {
    const [cards, usdRate] = await Promise.all([searchCards(query), getUsdToNzdRate()]);
    // Collectr prices are USD — convert to NZD here so every price shown to
    // the customer, and everything downstream (accept → submit → offer
    // calculation), is consistently NZD, matching the rest of the site.
    const withOffers = cards
      .filter((c) => c.isCard !== false && c.price > 0)
      .map((c) => {
        const priceNzd = Math.round(c.price * usdRate * 100) / 100;
        return { ...c, price: priceNzd, offerPrice: buyback.calculateOffer(priceNzd) };
      });
    res.json({ cards: withOffers, rate: buyback.BUYBACK_RATE });
  } catch (err) {
    console.error('[Buyback search] Error:', err.message);
    res.status(500).json({ error: 'Search failed. Please try again.' });
  }
});

app.post('/api/buyback/submit', rateLimitBuybackSubmit, async (req, res) => {
  const { card, customer, conditionNotes, acceptedOffer, frontPhoto, backPhoto } = req.body || {};

  if (acceptedOffer !== true) {
    return res.status(400).json({ error: 'You must accept the offer price before submitting.' });
  }
  if (!card || !card.name || !(parseFloat(card.price) > 0)) {
    return res.status(400).json({ error: 'Card details are required.' });
  }
  if (!customer || !customer.name || !customer.email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email);
  if (!emailOk) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!frontPhoto || !backPhoto) {
    return res.status(400).json({ error: 'Please upload a photo of both the front and back of the card.' });
  }

  const payload = {
    customerName: customer.name,
    customerEmail: customer.email,
    customerPhone: customer.phone || '',
    cardName: card.name,
    cardSet: card.setName || '',
    cardNumber: card.cardNumber || '',
    cardFinish: card.subType || '',
    cardImageUrl: card.imageUrl || '',
    frontPhotoDataUri: frontPhoto,
    backPhotoDataUri: backPhoto,
    collectrId: card.collectrId || '',
    marketPrice: parseFloat(card.price) || 0,
    conditionNotes: (conditionNotes || '').slice(0, 2000),
  };

  try {
    const submission = await buyback.createSubmission(payload);
    buyback.notifyOwnerOfSubmission(payload, submission.offerPrice).catch(() => {});
    res.json({
      success: true,
      offerPrice: submission.offerPrice,
      message: "Thanks — we've received your submission and will review it shortly.",
    });
  } catch (err) {
    console.error('[Buyback submit] Error:', err.message);
    res.status(500).json({ error: 'Could not submit right now. Please try again shortly.' });
  }
});

app.post('/api/add-card', requireToken, async (req, res) => {
  const { card, multiplier } = req.body;
  const { sync, shopify } = getConfig();

  if (!card || !card.name) return res.status(400).json({ error: 'Card data is required.' });

  const mult = parseFloat(multiplier) || sync.defaultMultiplier;

  try {
    const result = await addOrUpdateProduct(card, mult);
    const product = result.product;
    const storeHandle = shopify.store.replace('.myshopify.com', '');
    res.json({
      success: true,
      incremented: result.incremented,
      quantity: result.quantity,
      warning: result.warning || null,
      product: {
        id: product.id,
        title: product.title,
        price: result.price || product.variants[0]?.price,
        quantity: result.quantity,
        shopifyUrl: `https://admin.shopify.com/store/${storeHandle}/products/${product.id}`,
      },
    });
  } catch (err) {
    const shopifyDetail = err.response?.data;
    console.error('Add card error:', err.message, shopifyDetail || '');
    res.status(500).json({
      error: formatShopifyError(err),
      status: err.response?.status || null,
      shopify: shopifyDetail || null,
    });
  }
});

app.post('/api/bulk-add', requireToken, async (req, res) => {
  const { cards, multiplier, onlyNew } = req.body;
  const { sync } = getConfig();

  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: 'Send { cards: [...] } with at least one card from search results.' });
  }

  const mult = parseFloat(multiplier) || sync.defaultMultiplier;

  try {
    const results = await bulkAddCards(cards, mult, { onlyNew: !!onlyNew });
    res.json({ success: true, ...results });
  } catch (err) {
    console.error('Bulk add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', requireToken, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const products = await getManagedProducts();
    res.json({ products, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/delete-all', requireToken, async (req, res) => {
  if (req.body?.confirm !== 'DELETE ALL') {
    return res.status(400).json({
      error: 'Send { "confirm": "DELETE ALL" } to permanently remove all collectr-managed products.',
    });
  }

  try {
    const results = await deleteAllManagedProducts();
    invalidateManagedProductsCache();
    res.json({ success: true, ...results });
  } catch (err) {
    console.error('Delete all error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', requireToken, async (req, res) => {
  const { id } = req.params;
  try {
    await deleteProduct(id);
    invalidateManagedProductsCache();
    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/products/:id/multiplier', requireToken, async (req, res) => {
  const { id } = req.params;
  const { multiplier } = req.body;
  if (!multiplier || isNaN(parseFloat(multiplier))) return res.status(400).json({ error: 'Valid multiplier required.' });

  try {
    await setMultiplier(id, parseFloat(multiplier));
    invalidateManagedProductsCache();
    res.json({ success: true, multiplier: parseFloat(multiplier) });
  } catch (err) {
    console.error('Multiplier error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/products/:id/quantity', requireToken, async (req, res) => {
  const { id } = req.params;
  const { quantity } = req.body;
  const qty = parseInt(quantity, 10);
  if (quantity == null || isNaN(qty) || qty < 0) {
    return res.status(400).json({ error: 'Valid non-negative quantity required.' });
  }

  try {
    const newQty = await setProductQuantity(id, qty);
    res.json({ success: true, quantity: newQty });
  } catch (err) {
    console.error('Quantity error:', err.message);
    res.status(500).json({ error: formatShopifyError(err) });
  }
});

/**
 * PATCH /api/products/bulk-multiplier
 * Apply one multiplier to EVERY managed product at once.
 * New price shows up for each product on its next sync.
 */
app.patch('/api/products/bulk-multiplier', requireToken, async (req, res) => {
  const { multiplier } = req.body;
  if (!multiplier || isNaN(parseFloat(multiplier))) return res.status(400).json({ error: 'Valid multiplier required.' });

  try {
    const result = await setMultiplierBulk(parseFloat(multiplier));
    invalidateManagedProductsCache();
    res.json({ success: true, multiplier: parseFloat(multiplier), ...result });
  } catch (err) {
    console.error('Bulk multiplier error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/:id/sync', requireToken, async (req, res) => {
  const { id } = req.params;
  try {
    const { newPrice, freshCard, product } = await syncProductById(id);
    res.json({
      success: true,
      price: newPrice,
      marketPrice: freshCard.price,
      cardNumber: product.cardNumber,
      subType: product.subType,
    });
  } catch (err) {
    console.error('Sync one error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const syncJobs = new Map();
let activeSyncJobId = null;
let lastSyncSummary = null; // { source, startedAt, finishedAt, total, updated, failed, errors, status }

function recordLastSync(job, source) {
  lastSyncSummary = {
    source, // 'cron' or 'manual'
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    total: job.total,
    updated: job.updated,
    failed: job.failed,
    errors: job.errors,
    status: job.status, // 'done' or 'failed'
  };
}

function createSyncJob() {
  const id = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const job = {
    id,
    status: 'running',
    phase: 'starting',
    message: 'Starting…',
    total: 0,
    current: 0,
    updated: 0,
    failed: 0,
    detail: '',
    errors: [],
    startedAt: now,
    finishedAt: null,
  };
  syncJobs.set(id, job);
  activeSyncJobId = id;
  return job;
}

function applySyncEvent(job, evt) {
  if (!evt || !job) return;
  if (evt.type === 'phase') {
    job.message = evt.message || job.message;
    job.phase = 'phase';
    return;
  }
  if (evt.type === 'start') {
    job.total = evt.total || 0;
    job.current = 0;
    job.updated = 0;
    job.failed = 0;
    job.phase = 'running';
    job.message = `Syncing ${job.total} products…`;
    return;
  }
  if (evt.type === 'progress') {
    if (evt.current != null) job.current = evt.current;
    if (evt.total != null) job.total = evt.total;
    if (evt.updated != null) job.updated = evt.updated;
    if (evt.failed != null) job.failed = evt.failed;
    if (evt.phase) job.phase = evt.phase;
    job.message =
      evt.current != null && evt.total != null
        ? `Card ${evt.current} of ${evt.total}`
        : job.message;
    job.detail = evt.detail || evt.title || '';
    return;
  }
  if (evt.type === 'item') {
    if (evt.current != null) job.current = evt.current;
    if (evt.total != null) job.total = evt.total;
    if (evt.updated != null) job.updated = evt.updated;
    if (evt.failed != null) job.failed = evt.failed;
    if (!evt.ok) {
      job.errors.push({
        product: evt.title || 'Product',
        error: evt.error || 'Sync failed',
      });
    }
    job.detail = evt.ok
      ? `✓ ${evt.title || ''}${evt.price ? ` → $${evt.price}` : ''}`.trim()
      : `✗ ${evt.title || ''}: ${evt.error || 'Sync failed'}`.trim();
    return;
  }
  if (evt.type === 'done') {
    job.status = 'done';
    job.phase = 'done';
    job.total = evt.total || job.total;
    job.updated = evt.updated ?? evt.success ?? job.updated;
    job.failed = evt.failed ?? job.failed;
    job.errors = Array.isArray(evt.errors) ? evt.errors : job.errors;
    job.message = `Done — ${job.updated} updated, ${job.failed} failed`;
    job.detail = '';
    job.finishedAt = new Date().toISOString();
  }
}

function startSyncJob(source = 'manual') {
  const job = createSyncJob();
  (async () => {
    try {
      await syncAllPrices((evt) => applySyncEvent(job, evt));
      if (job.status !== 'done') {
        job.status = 'done';
        job.phase = 'done';
        job.finishedAt = new Date().toISOString();
      }
    } catch (err) {
      console.error('Sync job error:', err.message);
      job.status = 'failed';
      job.phase = 'failed';
      job.message = err.message || 'Sync failed';
      job.errors.push({ product: 'Sync job', error: job.message });
      job.finishedAt = new Date().toISOString();
    } finally {
      if (activeSyncJobId === job.id) activeSyncJobId = null;
      recordLastSync(job, source);
    }
  })();
  return job;
}

app.post('/api/sync/start', requireToken, async (req, res) => {
  if (activeSyncJobId) {
    const running = syncJobs.get(activeSyncJobId);
    if (running && running.status === 'running') {
      return res.status(409).json({
        success: false,
        error: 'A sync is already running.',
        jobId: running.id,
        job: running,
      });
    }
  }
  const job = startSyncJob();
  res.json({ success: true, jobId: job.id, job });
});

app.get('/api/sync/status/:id', requireToken, async (req, res) => {
  const job = syncJobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Sync job not found' });
  }
  res.json({ success: true, job });
});

app.post('/api/sync', requireToken, async (req, res) => {
  const startedAt = new Date().toISOString();
  try {
    const results = await syncAllPrices();
    lastSyncSummary = {
      source: 'manual',
      startedAt,
      finishedAt: new Date().toISOString(),
      total: results.success + results.failed,
      updated: results.success,
      failed: results.failed,
      errors: results.errors,
      status: 'done',
    };
    res.json({
      success: true,
      updated: results.success,
      failed: results.failed,
      errors: results.errors,
    });
  } catch (err) {
    lastSyncSummary = {
      source: 'manual',
      startedAt,
      finishedAt: new Date().toISOString(),
      total: 0,
      updated: 0,
      failed: 0,
      errors: [{ product: 'Sync', error: err.message }],
      status: 'failed',
    };
    console.error('Sync error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/sync/last
 * The most recent sync result, whichever way it was triggered (cron or manual).
 * Lets the UI show "Last synced: X ago — N updated, M failed" without
 * anyone needing to check Railway's logs.
 */
app.get('/api/sync/last', requireToken, (req, res) => {
  res.json({ lastSync: lastSyncSummary, syncRunning: !!activeSyncJobId });
});

// ── Cron ──────────────────────────────────────────────────────────────────────
// NOTE: previously this had no timezone set, so "6am" ran on the server's
// clock — which on Railway is UTC, i.e. 6-7pm in New Zealand, not 6am.
// Explicitly using Pacific/Auckland fixes that (and handles NZ's daylight
// saving shift automatically).

const { sync } = getConfig();
cron.schedule(
  sync.cronSchedule,
  () => {
    console.log(`[CRON] Price sync started at ${new Date().toISOString()}`);
    if (activeSyncJobId) {
      console.log('[CRON] Skipped — a sync is already in progress.');
      return;
    }
    startSyncJob('cron');
  },
  { timezone: 'Pacific/Auckland' }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  const { shopify, sync: s } = getConfig();
  console.log(`\nHolo Vault Price Sync running at http://localhost:${PORT}`);
  console.log(`Shopify store: ${shopify.store}`);
  console.log('Sync: reads card # / finish from metafields or product description (v2)');
  if (!hasShopifyCredentials()) {
    console.log(
      '⚠️  Shopify credentials missing. Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_TOKEN) in .env / Railway.'
    );
  } else {
    try {
      await ensureAccessToken();
      const auth = getAuthStatus();
      if (auth.mode === 'client_credentials') {
        console.log(`✓ Shopify auth: client credentials (auto-refresh), scopes: ${auth.scopes || '—'}`);
        warnMissingShopifyScopes(auth.scopes);
        if (auth.expiresInHours != null) {
          console.log(`  Token valid ~${auth.expiresInHours}h (refreshes automatically before expiry)`);
        }
      } else {
        console.log('✓ Shopify auth: static SHOPIFY_TOKEN');
      }
      console.log(`Daily sync scheduled: ${s.cronSchedule}`);
    } catch (err) {
      console.log('⚠️  Shopify auth failed:', err.message);
    }

    try {
      await buyback.ensureBuybackMetaobjectDefinition();
    } catch (err) {
      console.warn('[Buyback] Metaobject definition setup skipped:', err.message);
    }
  }
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await closeBrowser();
  process.exit(0);
});
