// netlify/functions/free-download.js
//
// Called directly by the "Download for free" button — no Paystack involved,
// since there's no payment to verify. This function is public, so it MUST
// re-check the product's price is actually 0 in the catalog before handing
// out a signed link — otherwise anyone could request a paid image for free
// just by knowing its id.
//
// Called as: /.netlify/functions/free-download?id=edu001

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;

const LINK_EXPIRY_SECONDS = 60 * 60;

const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vSdzp1q8QkhrOGKPCmk8vO74ClEG1VGKFaIuU9Z_qu_pI-4ogbM5TJuiPxW7FF_Xen2hWpM1eUUNaG8/pub?gid=510014079&single=true&output=csv';

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const productId = event.queryStringParameters && event.queryStringParameters.id;

  if (!productId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing id parameter' }) };
  }

  try {
    const csvRes = await fetch(CSV_URL);
    const csvText = await csvRes.text();
    const rows = parseCSV(csvText);
    const product = rows.find((r) => r.id === productId);

    if (!product) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Product not found' }) };
    }

    const price = Number(product.price);
    if (price && price > 0) {
      return { statusCode: 403, body: JSON.stringify({ error: 'This product is not free' }) };
    }

    if (!product.r2_key) {
      return { statusCode: 404, body: JSON.stringify({ error: 'No file associated with this product' }) };
    }

    const command = new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: product.r2_key,
    });
    const signedUrl = await getSignedUrl(r2, command, { expiresIn: LINK_EXPIRY_SECONDS });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: signedUrl }),
    };
  } catch (err) {
    console.error('free-download error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong' }) };
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
