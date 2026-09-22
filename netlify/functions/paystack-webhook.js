// netlify/functions/paystack-webhook.js
//
// This function is called automatically by Paystack whenever a payment
// event happens on your account. We only act on "charge.success" events.
//
// Flow:
//   1. Verify the request really came from Paystack (signature check)
//   2. Confirm the payment actually succeeded (never trust the webhook body alone)
//   3. Work out which product was bought (from the payment reference/metadata)
//   4. Generate a temporary signed download link from Cloudflare R2
//   5. Email that link to the buyer via Resend

const crypto = require('crypto');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Resend } = require('resend');

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// How long the download link stays valid after being generated.
const LINK_EXPIRY_SECONDS = 60 * 60; // 1 hour

const resend = new Resend(RESEND_API_KEY);

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const signature = event.headers['x-paystack-signature'];
  const expectedSignature = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(event.body)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error('Invalid Paystack signature — request rejected.');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const payload = JSON.parse(event.body);

  if (payload.event !== 'charge.success') {
    return { statusCode: 200, body: 'Ignored (not a successful charge)' };
  }

  const data = payload.data;
  const buyerEmail = data.customer && data.customer.email;

  const productId =
    (data.metadata && (data.metadata.product_id || data.metadata.custom_fields?.find(f => f.variable_name === 'product_id')?.value));

  if (!productId) {
    console.error('No product_id found in payment metadata.', data.metadata);
    return { statusCode: 200, body: 'No product_id in metadata — cannot deliver file' };
  }

  if (!buyerEmail) {
    console.error('No buyer email found on payment.');
    return { statusCode: 200, body: 'No buyer email — cannot deliver file' };
  }

  try {
    const CSV_URL =
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vSdzp1q8QkhrOGKPCmk8vO74ClEG1VGKFaIuU9Z_qu_pI-4ogbM5TJuiPxW7FF_Xen2hWpM1eUUNaG8/pub?gid=510014079&single=true&output=csv';

    const csvRes = await fetch(CSV_URL);
    const csvText = await csvRes.text();
    const rows = parseCSV(csvText);
    const product = rows.find((r) => r.id === productId);

    if (!product || !product.r2_key) {
      console.error(`Product "${productId}" not found in catalog, or has no r2_key.`);
      return { statusCode: 200, body: 'Product not found in catalog' };
    }

    const extension = (product.r2_key.split('.').pop() || 'jpg').toLowerCase();
    const safeTitle = (product.title || product.r2_key)
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
    const downloadFilename = `${safeTitle || 'feygrace-image'}.${extension}`;

    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: product.r2_key,
      ResponseContentDisposition: `attachment; filename="${downloadFilename}"`,
    });
    const signedUrl = await getSignedUrl(r2, command, { expiresIn: LINK_EXPIRY_SECONDS });
    await resend.emails.send({
      from: 'Feygrace Stock <onboarding@resend.dev>',
      to: buyerEmail,
      reply_to: 'feygracestockimages@gmail.com',
      subject: `Your download: ${product.title}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#111;">Thanks for your purchase!</h2>
          <p>Here's your download for <strong>${escapeHtml(product.title)}</strong>.</p>
          <p style="margin: 24px 0;">
            <a href="${signedUrl}"
               style="background:#ff7a1a;color:#0a0a0a;padding:14px 22px;
                      text-decoration:none;font-weight:600;border-radius:2px;display:inline-block;">
              Download your image
            </a>
          </p>
          <p style="color:#666;font-size:13px;">
            This link expires in 1 hour for security. If it stops working, just reply to this
            email and we'll send a fresh one.
          </p>
          <p style="color:#666;font-size:13px;">— Feygrace Stock</p>
        </div>
      `,
    });

    console.log(`Delivered "${productId}" to ${buyerEmail}`);
    return { statusCode: 200, body: 'Delivered' };
  } catch (err) {
    console.error('Delivery failed:', err);
    return { statusCode: 200, body: 'Error during delivery — check logs' };
  }
};

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.length > 1 || r[0])
    .map((r) => {
      const obj = {};
      headers.forEach((h, idx) => (obj[h] = (r[idx] || '').trim()));
      return obj;
    });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  }
