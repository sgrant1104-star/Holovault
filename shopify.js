/**
 * shopify.js
 * Reads config purely from environment variables.
 */

require('dotenv').config();

const axios = require('axios');

function getShopifyConfig() {
  const store = process.env.SHOPIFY_STORE || '';
  const accessToken = process.env.SHOPIFY_TOKEN || '';
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-04';
  console.log(`[Shopify] Store: ${store}, Token: ${accessToken ? accessToken.substring(0, 10) + '...' : 'MISSING'}`);
  return { store, accessToken, apiVersion };
}

function getClient() {
  const { store, accessToken, apiVersion } = getShopifyConfig();
  const BASE = `https://${store}/admin/api/${apiVersion}`;
  return {
    client: axios.create({
      baseURL: BASE,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    }),
    BASE,
  };
}

/**
 * Create a new product in Shopify from Collectr card data.
 */
async function createProduct(card, multiplier = 1.0) {
  const { client } = getClient();
  const finalPrice = (card.price * multiplier).toFixed(2);

  const body = {
    product: {
      title: card.name,
      body_html: buildDescription(card),
      vendor: card.setName || 'Pokemon TCG',
      product_type: 'Pokemon Card',
      tags: 'collectr-managed, ' + buildTags(card),
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

  await setProductMetafields(product.id, card, multiplier);

  return product;
}

/**
 * Update the price of an existing Shopify product.
 */
async function updateProductPrice(productId, variantId, card, multiplier = 1.0) {
  const { client } = getClient();
  const finalPrice = (card.price * multiplier).toFixed(2);

  await client.put(`/variants/${variantId}.json`, {
    variant: {
      id: variantId,
      price: finalPrice,
    },
  });

  await setProductMetafields(productId, card, multiplier);

  return finalPrice;
}

/**
 * Store Collectr price data as product metafields.
 */
async function setProductMetafields(productId, card, multiplier) {
  const { client } = getClient();

  const metafields = [
    { namespace: 'custom', key: 'market_price', value: card.price.toString(), type: 'number_decimal' },
    { namespace: 'custom', key: 'price_change', value: card.priceChange.toString(), type: 'number_decimal' },
    { namespace: 'custom', key: 'price_change_pct', value: card.priceChangePct.toString(), type: 'number_decimal' },
    { namespace: 'custom', key: 'multiplier', value: multiplier.toString(), type: 'number_decimal' },
    { namespace: 'custom', key: 'collectr_id', value: card.collectrId ? card.collectrId.toString() : '', type: 'single_line_text_field' },
    { namespace: 'custom', key: 'collectr_url', value: card.collectrUrl || '', type: 'single_line_text_field' },
    { namespace: 'custom', key: 'last_synced', value: new Date().toISOString(), type: 'single_line_text_field' },
  ];

  for (const mf of metafields) {
    await client.post(`/products/${productId}/metafields.json`, { metafield: mf }).catch(() => {});
  }
}

/**
 * Get all Collectr-managed products (identified by tag).
 */
async function getManagedProducts() {
  const { client, BASE } = getClient();
  const products = [];
  let url = '/products.json?limit=250&fields=id,title,variants,tags';

  while (url) {
    const res = await client.get(url.startsWith('/') ? url : url.replace(BASE, ''));
    products.push(...res.data.products);

    const linkHeader = res.headers['link'];
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1].replace(BASE, '') : null;
    } else {
      url = null;
    }
  }

  const managed = products.filter(p => p.tags && p.tags.includes('collectr-managed'));

  const result = [];
  for (const product of managed) {
    const mfRes = await client.get(`/products/${product.id}/metafields.json`)
      .catch(() => ({ data: { metafields: [] } }));
    const metafields = mfRes.data.metafields;

    const collectrId = metafields.find((m) => m.key === 'collectr_id');
    const collectrUrl = metafields.find((m) => m.key === 'collectr_url');
    const multiplier = metafields.find((m) => m.key === 'multiplier');

    result.push({
      productId: product.id,
      variantId: product.variants[0]?.id,
      title: product.title,
      collectrId: collectrId?.value || null,
      collectrUrl: collectrUrl?.value || null,
      multiplier: multiplier ? parseFloat(multiplier.value) : 1.0,
    });
  }

  return result;
}

/**
 * Update the multiplier for a specific product.
 */
async function setMultiplier(productId, multiplier) {
  const { client } = getClient();
  await client.post(`/products/${productId}/metafields.json`, {
    metafield: {
      namespace: 'custom',
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
