/**
 * shopify.js
 * Shopify Admin API wrapper — create/update products and metafields.
 */

const axios = require('axios');
const config = require('./config.json');

const { store, accessToken, apiVersion } = config.shopify;
const BASE = `https://${store}/admin/api/${apiVersion}`;

const client = axios.create({
  baseURL: BASE,
  headers: {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  },
});

/**
 * Create a new product in Shopify from Collectr card data.
 * @param {object} card  - card object from collectr.js
 * @param {number} multiplier - price multiplier (e.g. 0.8 = 80% of market)
 */
async function createProduct(card, multiplier = 1.0) {
  const finalPrice = (card.price * multiplier).toFixed(2);

  const body = {
    product: {
      title: card.name,
      body_html: buildDescription(card),
      vendor: card.setName || 'Pokemon TCG',
      product_type: 'Pokemon Card',
      tags: buildTags(card),
      variants: [
        {
          price: finalPrice,
          inventory_management: null,
          fulfillment_service: 'manual',
          inventory_policy: 'continue',
        },
      ],
      images: card.imageUrl ? [{ src: card.imageUrl }] : [],
    },
  };

  const res = await client.post('/products.json', body);
  const product = res.data.product;

  // Store Collectr metadata as metafields
  await setProductMetafields(product.id, card, multiplier);

  return product;
}

/**
 * Update the price of an existing Shopify product.
 * @param {string} productId  - Shopify product ID
 * @param {string} variantId  - Shopify variant ID
 * @param {object} card       - fresh card data from Collectr
 * @param {number} multiplier - per-card multiplier
 */
async function updateProductPrice(productId, variantId, card, multiplier = 1.0) {
  const finalPrice = (card.price * multiplier).toFixed(2);

  await client.put(`/variants/${variantId}.json`, {
    variant: {
      id: variantId,
      price: finalPrice,
    },
  });

  // Update metafields with latest price data
  await setProductMetafields(productId, card, multiplier);

  return finalPrice;
}

/**
 * Store Collectr price data as product metafields.
 * These are used by the theme to show the price badge.
 */
async function setProductMetafields(productId, card, multiplier) {
  const metafields = [
    {
      namespace: 'custom',
      key: 'market_price',
      value: card.price.toString(),
      type: 'number_decimal',
    },
    {
      namespace: 'custom',
      key: 'price_change',
      value: card.priceChange.toString(),
      type: 'number_decimal',
    },
    {
      namespace: 'custom',
      key: 'price_change_pct',
      value: card.priceChangePct.toString(),
      type: 'number_decimal',
    },
    {
      namespace: 'custom',
      key: 'multiplier',
      value: multiplier.toString(),
      type: 'number_decimal',
    },
    {
      namespace: 'custom',
      key: 'collectr_id',
      value: card.collectrId ? card.collectrId.toString() : '',
      type: 'single_line_text_field',
    },
    {
      namespace: 'custom',
      key: 'collectr_url',
      value: card.collectrUrl || '',
      type: 'single_line_text_field',
    },
    {
      namespace: 'custom',
      key: 'last_synced',
      value: new Date().toISOString(),
      type: 'single_line_text_field',
    },
  ];

  // Shopify requires metafields to be set one at a time via product update
  await client.post(`/products/${productId}/metafields.json`, {
    metafield: metafields[0],
  }).catch(() => {});

  for (const mf of metafields.slice(1)) {
    await client.post(`/products/${productId}/metafields.json`, { metafield: mf }).catch(() => {});
  }
}

/**
 * Get all products that have a collectr_id metafield (i.e. managed by this tool).
 */
async function getManagedProducts() {
  const products = [];
  let url = '/products.json?limit=250&fields=id,title,variants,metafields';
  
  while (url) {
    const res = await client.get(url.startsWith('/') ? url : url.replace(BASE, ''));
    products.push(...res.data.products);

    // Handle pagination
    const linkHeader = res.headers['link'];
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1].replace(BASE, '') : null;
    } else {
      url = null;
    }
  }

  // For each product, fetch its metafields to find collectr-managed ones
  const managed = [];
  for (const product of products) {
    const mfRes = await client.get(`/products/${product.id}/metafields.json`).catch(() => ({ data: { metafields: [] } }));
    const metafields = mfRes.data.metafields;

    const collectrId = metafields.find((m) => m.namespace === 'custom' && m.key === 'collectr_id');
    const collectrUrl = metafields.find((m) => m.namespace === 'custom' && m.key === 'collectr_url');
    const multiplier = metafields.find((m) => m.namespace === 'custom' && m.key === 'multiplier');

    if (collectrId || collectrUrl) {
      managed.push({
        productId: product.id,
        variantId: product.variants[0]?.id,
        title: product.title,
        collectrId: collectrId?.value || null,
        collectrUrl: collectrUrl?.value || null,
        multiplier: multiplier ? parseFloat(multiplier.value) : 1.0,
      });
    }
  }

  return managed;
}

/**
 * Update the multiplier for a specific product.
 */
async function setMultiplier(productId, multiplier) {
  await client.post(`/products/${productId}/metafields.json`, {
    metafield: {
      namespace: 'collectr',
      key: 'multiplier',
      value: multiplier.toString(),
      type: 'number_decimal',
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildDescription(card) {
  const parts = [];
  if (card.setName) parts.push(`<strong>Set:</strong> ${card.setName}`);
  if (card.cardNumber) parts.push(`<strong>Number:</strong> ${card.cardNumber}`);
  if (card.rarity) parts.push(`<strong>Rarity:</strong> ${card.rarity}`);
  parts.push(`<em>Price sourced from Collectr. Updated daily.</em>`);
  return parts.join('<br>');
}

function buildTags(card) {
  const tags = ['pokemon', 'tcg'];
  if (card.setName) tags.push(card.setName.toLowerCase().replace(/\s+/g, '-'));
  if (card.rarity) tags.push(card.rarity.toLowerCase().replace(/\s+/g, '-'));
  return tags.join(', ');
}

module.exports = { createProduct, updateProductPrice, getManagedProducts, setMultiplier };
