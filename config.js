const fs = require('fs');
const path = require('path');

function getConfig() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  // Allow environment variables to override config values
  if (process.env.SHOPIFY_TOKEN) raw.shopify.accessToken = process.env.SHOPIFY_TOKEN;
  if (process.env.SHOPIFY_STORE) raw.shopify.store = process.env.SHOPIFY_STORE;
  if (process.env.SHOPIFY_CLIENT_ID) raw.shopify.clientId = process.env.SHOPIFY_CLIENT_ID;
  if (process.env.SHOPIFY_SECRET) raw.shopify.clientSecret = process.env.SHOPIFY_SECRET;
  if (process.env.SHOPIFY_API_VERSION) raw.shopify.apiVersion = process.env.SHOPIFY_API_VERSION;
  return raw;
}

module.exports = { getConfig };
