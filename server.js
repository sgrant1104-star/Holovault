// Test change: verifying commit/push/deploy pipeline.
/**
 * server.js
 * Express server — serves the admin UI and API endpoints.
 * Also runs the daily price sync cron job.
 *
 * Auth flow:
 *   1. Visit http://localhost:3000/auth  → redirects to Shopify
 *   2. Approve the app in Shopify
 *   3. Shopify redirects to /auth/callback → token saved to config.json
 *   4. All done — app works normally from here
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { searchCards, closeBrowser } = require('./collectr');
const { createProduct, getManagedProducts, setMultiplier } = require('./shopify');
const { syncAllPrices } = require('./sync-prices');

function getConfig() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  // Allow environment variables to override config values
  if (process.env.SHOPIFY_TOKEN) raw.shopify.accessToken = process.env.SHOPIFY_TOKEN;
  if (process.env.SHOPIFY_STORE) raw.shopify.store = process.env.SHOPIFY_STORE;
  return raw;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── OAuth ─────────────────────────────────────────────────────────────────────

const SCOPES = 'read_products,write_products';
const REDIRECT_URI = 'http://localhost:3000/auth/callback';

// Step 1 — Start OAuth: visit http://localhost:3000/auth
app.get('/auth', (req, res) => {
  const config = getConfig();
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl =
    `https://${config.shopify.store}/admin/oauth/authorize` +
    `?client_id=${config.shopify.clientId}` +
    `&scope=${SCOPES}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}`;

  // Store state in a temp file to verify on callback
  fs.writeFileSync(path.join(__dirname, '.oauth_state'), state);
  res.redirect(authUrl);
});

// Step 2 — Callback: Shopify redirects here after approval
app.get('/auth/callback', async (req, res) => {
  const { code, state, hmac, shop } = req.query;
  const config = getConfig();

  // Verify state to prevent CSRF
  const savedState = fs.existsSync(path.join(__dirname, '.oauth_state'))
    ? fs.readFileSync(path.join(__dirname, '.oauth_state'), 'utf8')
    : null;

  if (!savedState || state !== savedState) {
    return res.status(403).send('Invalid state. Please try again: <a href="/auth">Retry</a>');
  }
  fs.unlinkSync(path.join(__dirname, '.oauth_state'));

  // Verify HMAC signature from Shopify
  const params = Object.entries(req.query)
    .filter(([k]) => k !== 'hmac')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', config.shopify.clientSecret)
    .update(params)
    .digest('hex');

  if (digest !== hmac) {
    return res.status(403).send('HMAC verification failed. Please try again: <a href="/auth">Retry</a>');
  }

  // Exchange code for permanent access token
  try {
    const tokenRes = await axios.post(
      `https://${config.shopify.store}/admin/oauth/access_token`,
      {
        client_id: config.shopify.clientId,
        client_secret: config.shopify.clientSecret,
        code,
      }
    );

    const accessToken = tokenRes.data.access_token;

    // Save token to config.json
    config.shopify.accessToken = accessToken;
    fs.writeFileSync(
      path.join(__dirname, 'config.json'),
      JSON.stringify(config, null, 2)
    );

    console.log('[Auth] ✓ Access token saved to config.json');
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0f0f0f;color:#e0e0e0">
        <h2 style="color:#4ade80">✓ Shopify connected successfully!</h2>
        <p>Your access token has been saved.</p>
        <a href="/" style="color:#60a5fa">← Go to Card Manager</a>
      </body></html>
    `);
  } catch (err) {
    console.error('[Auth] Token exchange failed:', err.response?.data || err.message);
    res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0f0f0f;color:#e0e0e0">
        <h2 style="color:#f87171">✗ Auth failed</h2>
        <p>${err.response?.data?.error_description || err.message}</p>
        <a href="/auth" style="color:#60a5fa">Try again</a>
      </body></html>
    `);
  }
});

// ── Middleware: check token is set ────────────────────────────────────────────

function requireToken(req, res, next) {
  const config = getConfig();
  if (!config.shopify.accessToken) {
    return res.status(401).json({
      error: 'Not authenticated. Visit http://localhost:3000/auth to connect Shopify.',
    });
  }
  next();
}

// ── API Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/search?q=charizard
 * Search Collectr for cards matching the query.
 * Collectr search URL format: https://app.getcollectr.com/?query=charizard
 */
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (query.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters.' });
  }

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

/**
 * POST /api/add-card
 * Add a card to Shopify.
 * Body: { card: {...}, multiplier: 1.0 }
 */
app.post('/api/add-card', requireToken, async (req, res) => {
  const { card, multiplier } = req.body;
  const config = getConfig();

  if (!card || !card.name) {
    return res.status(400).json({ error: 'Card data is required.' });
  }

  const mult = parseFloat(multiplier) || config.sync.defaultMultiplier;

  try {
    const product = await createProduct(card, mult);
    res.json({
      success: true,
      product: {
        id: product.id,
        title: product.title,
        price: product.variants[0]?.price,
        shopifyUrl: `https://admin.shopify.com/store/fxtvvc-5c/products/${product.id}`,
      },
    });
  } catch (err) {
    console.error('Add card error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/products
 * List all Collectr-managed products in Shopify.
 */
app.get('/api/products', requireToken, async (req, res) => {
  try {
    const products = await getManagedProducts();
    res.json({ products });
  } catch (err) {
    console.error('Products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/products/:id/multiplier
 * Update the price multiplier for a product.
 * Body: { multiplier: 0.8 }
 */
app.patch('/api/products/:id/multiplier', requireToken, async (req, res) => {
  const { id } = req.params;
  const { multiplier } = req.body;

  if (!multiplier || isNaN(parseFloat(multiplier))) {
    return res.status(400).json({ error: 'Valid multiplier is required.' });
  }

  try {
    await setMultiplier(id, parseFloat(multiplier));
    res.json({ success: true, multiplier: parseFloat(multiplier) });
  } catch (err) {
    console.error('Multiplier update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync
 * Manually trigger a price sync.
 */
app.post('/api/sync', requireToken, async (req, res) => {
  res.json({ success: true, message: 'Sync started. Check server logs for progress.' });
  try {
    await syncAllPrices();
  } catch (err) {
    console.error('Manual sync error:', err.message);
  }
});

/**
 * GET /api/status
 * Check if Shopify token is configured.
 */
app.get('/api/status', (req, res) => {
  const config = getConfig();
  res.json({
    connected: !!config.shopify.accessToken,
    store: config.shopify.store,
  });
});

// ── Cron Job ──────────────────────────────────────────────────────────────────

const config = getConfig();
cron.schedule(config.sync.cronSchedule, async () => {
  console.log(`[CRON] Running scheduled price sync at ${new Date().toISOString()}`);
  try {
    await syncAllPrices();
  } catch (err) {
    console.error('[CRON] Sync failed:', err.message);
  }
});

// ── Start Server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const cfg = getConfig();
  console.log(`\nHolo Vault Price Sync running at http://localhost:${PORT}`);
  console.log(`Shopify store: ${cfg.shopify.store}`);
  if (!cfg.shopify.accessToken) {
    console.log('\n⚠️  Not connected to Shopify yet.');
    console.log('   → Open http://localhost:3000/auth in your browser to connect.\n');
  } else {
    console.log('✓ Shopify token found — ready to go.');
    console.log(`Daily sync scheduled: ${cfg.sync.cronSchedule}`);
  }
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await closeBrowser();
  process.exit(0);
});
