/**
 * buyback.js
 * "Sell your cards to us" submission pipeline.
 *
 * Submissions are stored as Shopify metaobjects (Content → Metaobjects in
 * Shopify Admin) rather than a separate database — Railway has no
 * persistent volume, and this keeps everything in the one place the owner
 * already reviews the store from. Approval/rejection happens by editing the
 * "status" field on the metaobject directly in Shopify Admin; everything
 * after approval (shipping address, bank details, payment) is handled
 * manually by the owner over email, by design.
 */

const nodemailer = require('nodemailer');
const { getClient, shopifyGraphql } = require('./shopify');

const BUYBACK_RATE = 0.75; // flat 75% of Collectr market price
const METAOBJECT_TYPE = 'card_buyback_submission';

let definitionEnsured = false;

/**
 * One-time setup: create the metaobject definition if it doesn't already
 * exist. Safe to call on every server start — checks first, only creates
 * when missing, so redeploys don't fail trying to recreate it.
 */
async function ensureBuybackMetaobjectDefinition() {
  if (definitionEnsured) return;
  const { client } = await getClient();

  const checkQuery = `
    query CheckBuybackDefinition($type: String!) {
      metaobjectDefinitionByType(type: $type) { id }
    }
  `;
  const existing = await shopifyGraphql(client, checkQuery, { type: METAOBJECT_TYPE });
  if (existing?.metaobjectDefinitionByType?.id) {
    await ensurePhotoFields();
    definitionEnsured = true;
    return;
  }

  const fieldDefs = [
    { key: 'customer_name', name: 'Customer name', type: 'single_line_text_field' },
    { key: 'customer_email', name: 'Customer email', type: 'single_line_text_field' },
    { key: 'customer_phone', name: 'Customer phone', type: 'single_line_text_field' },
    { key: 'card_name', name: 'Card name', type: 'single_line_text_field' },
    { key: 'card_set', name: 'Set', type: 'single_line_text_field' },
    { key: 'card_number', name: 'Card number', type: 'single_line_text_field' },
    { key: 'card_finish', name: 'Finish', type: 'single_line_text_field' },
    { key: 'card_image_url', name: 'Card image', type: 'single_line_text_field' },
    { key: 'collectr_id', name: 'Collectr ID', type: 'single_line_text_field' },
    { key: 'market_price', name: 'Market price (NZD)', type: 'number_decimal' },
    { key: 'offer_price', name: 'Offer price (NZD, 75%)', type: 'number_decimal' },
    { key: 'condition_notes', name: 'Condition notes', type: 'multi_line_text_field' },
    { key: 'status', name: 'Status', type: 'single_line_text_field' },
    { key: 'accepted_offer', name: 'Customer accepted offer', type: 'boolean' },
    { key: 'accepted_at', name: 'Accepted at', type: 'date_time' },
    { key: 'submitted_at', name: 'Submitted at', type: 'date_time' },
    { key: 'admin_notes', name: 'Admin notes', type: 'multi_line_text_field' },
    { key: 'front_photo', name: 'Front photo', type: 'file_reference' },
    { key: 'back_photo', name: 'Back photo', type: 'file_reference' },
  ];

  const mutation = `
    mutation CreateBuybackDefinition($definition: MetaobjectDefinitionCreateInput!) {
      metaobjectDefinitionCreate(definition: $definition) {
        metaobjectDefinition { id }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(client, mutation, {
    definition: {
      type: METAOBJECT_TYPE,
      name: 'Card Buyback Submission',
      fieldDefinitions: fieldDefs.map((f) => ({ key: f.key, name: f.name, type: f.type })),
    },
  });

  const errors = data?.metaobjectDefinitionCreate?.userErrors;
  if (errors?.length) {
    throw new Error('Metaobject definition create failed: ' + errors.map((e) => e.message).join('; '));
  }
  console.log('[Buyback] Metaobject definition created: card_buyback_submission');
  definitionEnsured = true;
}

/**
 * The definition already existed in production before photo fields were
 * added. Rather than recreate it (which would fail — Shopify won't let you
 * duplicate a type), add the two new fields to the existing definition if
 * they're not already there. Safe to call repeatedly — checks first.
 */
async function ensurePhotoFields() {
  const { client } = await getClient();
  const query = `
    query BuybackDefFields($type: String!) {
      metaobjectDefinitionByType(type: $type) {
        id
        fieldDefinitions { key }
      }
    }
  `;
  const data = await shopifyGraphql(client, query, { type: METAOBJECT_TYPE });
  const def = data?.metaobjectDefinitionByType;
  if (!def) return;

  const haveKeys = new Set((def.fieldDefinitions || []).map((f) => f.key));
  const toAdd = [];
  if (!haveKeys.has('front_photo')) {
    toAdd.push({ create: { key: 'front_photo', name: 'Front photo', type: 'file_reference' } });
  }
  if (!haveKeys.has('back_photo')) {
    toAdd.push({ create: { key: 'back_photo', name: 'Back photo', type: 'file_reference' } });
  }
  if (!toAdd.length) return;

  const mutation = `
    mutation AddPhotoFields($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
      metaobjectDefinitionUpdate(id: $id, definition: $definition) {
        metaobjectDefinition { id }
        userErrors { field message }
      }
    }
  `;
  const result = await shopifyGraphql(client, mutation, {
    id: def.id,
    definition: { fieldDefinitions: toAdd },
  });
  const errors = result?.metaobjectDefinitionUpdate?.userErrors;
  if (errors?.length) {
    console.warn('[Buyback] Could not add photo fields:', errors.map((e) => e.message).join('; '));
  } else {
    console.log('[Buyback] Added front_photo/back_photo fields to existing definition');
  }
}

/**
 * Upload a data-URI image (from the browser's FileReader) to Shopify Files
 * via the staged-upload flow, and return the resulting file GID once it's
 * ready. Used for the front/back condition photos.
 */
async function uploadImageToShopify(dataUri, filename) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri || '');
  if (!match) throw new Error('Invalid image data');
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('Image too large (max 8MB)');

  const { client } = await getClient();

  const stagedMutation = `
    mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }
  `;
  const staged = await shopifyGraphql(client, stagedMutation, {
    input: [{ filename, mimeType, httpMethod: 'POST', resource: 'FILE', fileSize: String(buffer.length) }],
  });
  const stagedErrors = staged?.stagedUploadsCreate?.userErrors;
  if (stagedErrors?.length) {
    throw new Error('Staged upload failed: ' + stagedErrors.map((e) => e.message).join('; '));
  }
  const target = staged.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const uploadRes = await fetch(target.url, { method: 'POST', body: form });
  if (uploadRes.status >= 300) {
    throw new Error('Image upload to Shopify failed (' + uploadRes.status + ')');
  }

  const fileCreateMutation = `
    mutation BuybackFileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus }
        userErrors { field message }
      }
    }
  `;
  const created = await shopifyGraphql(client, fileCreateMutation, {
    files: [{ alt: filename, contentType: 'IMAGE', originalSource: target.resourceUrl }],
  });
  const createErrors = created?.fileCreate?.userErrors;
  if (createErrors?.length) {
    throw new Error('File create failed: ' + createErrors.map((e) => e.message).join('; '));
  }
  return created.fileCreate.files[0].id;
}

/** Always 75% of market price, rounded to cents. Server-computed — never trust a client-sent offer price. */
function calculateOffer(marketPrice) {
  const price = parseFloat(marketPrice) || 0;
  return Math.round(price * BUYBACK_RATE * 100) / 100;
}

async function createSubmission(payload) {
  await ensureBuybackMetaobjectDefinition();
  const { client } = await getClient();

  const now = new Date().toISOString();
  const offerPrice = calculateOffer(payload.marketPrice);

  const [frontPhotoId, backPhotoId] = await Promise.all([
    payload.frontPhotoDataUri
      ? uploadImageToShopify(payload.frontPhotoDataUri, 'buyback-front-' + Date.now() + '.jpg')
      : null,
    payload.backPhotoDataUri
      ? uploadImageToShopify(payload.backPhotoDataUri, 'buyback-back-' + Date.now() + '.jpg')
      : null,
  ]);

  const fields = [
    { key: 'customer_name', value: payload.customerName || '' },
    { key: 'customer_email', value: payload.customerEmail || '' },
    { key: 'customer_phone', value: payload.customerPhone || '' },
    { key: 'card_name', value: payload.cardName || '' },
    { key: 'card_set', value: payload.cardSet || '' },
    { key: 'card_number', value: payload.cardNumber || '' },
    { key: 'card_finish', value: payload.cardFinish || '' },
    { key: 'card_image_url', value: payload.cardImageUrl || '' },
    { key: 'collectr_id', value: payload.collectrId ? String(payload.collectrId) : '' },
    { key: 'market_price', value: String(payload.marketPrice || 0) },
    { key: 'offer_price', value: String(offerPrice) },
    { key: 'condition_notes', value: payload.conditionNotes || '' },
    { key: 'status', value: 'Pending' },
    { key: 'accepted_offer', value: 'true' },
    { key: 'accepted_at', value: now },
    { key: 'submitted_at', value: now },
    { key: 'admin_notes', value: '' },
  ];
  if (frontPhotoId) fields.push({ key: 'front_photo', value: frontPhotoId });
  if (backPhotoId) fields.push({ key: 'back_photo', value: backPhotoId });

  const mutation = `
    mutation CreateSubmission($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(client, mutation, {
    metaobject: { type: METAOBJECT_TYPE, fields },
  });

  const errors = data?.metaobjectCreate?.userErrors;
  if (errors?.length) {
    throw new Error('Submission create failed: ' + errors.map((e) => e.message).join('; '));
  }
  return { ...data.metaobjectCreate.metaobject, offerPrice };
}

let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  mailer = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  return mailer;
}

async function notifyOwnerOfSubmission(payload, offerPrice) {
  const transporter = getMailer();
  if (!transporter) {
    console.warn('[Buyback] GMAIL_USER/GMAIL_APP_PASSWORD not set — skipping owner notification email');
    return;
  }
  const to = process.env.BUYBACK_NOTIFY_EMAIL || process.env.GMAIL_USER;
  const subject = `New card buyback submission: ${payload.cardName}`;
  const text = [
    `Card: ${payload.cardName} (${payload.cardSet || ''} ${payload.cardNumber || ''} ${payload.cardFinish || ''})`.trim(),
    `Market price: $${payload.marketPrice}`,
    `Offer (75%): $${offerPrice}`,
    '',
    `Customer: ${payload.customerName}`,
    `Email: ${payload.customerEmail}`,
    `Phone: ${payload.customerPhone}`,
    '',
    `Condition notes: ${payload.conditionNotes || '(none)'}`,
    '',
    'Review and approve in Shopify Admin → Content → Metaobjects → Card Buyback Submission.',
  ].join('\n');

  try {
    await transporter.sendMail({ from: process.env.GMAIL_USER, to, subject, text });
  } catch (err) {
    console.error('[Buyback] Notification email failed:', err.message);
  }
}

module.exports = {
  BUYBACK_RATE,
  calculateOffer,
  ensureBuybackMetaobjectDefinition,
  createSubmission,
  notifyOwnerOfSubmission,
};
