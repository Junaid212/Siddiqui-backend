const fs = require('fs');
const path = require('path');
const os = require('os');

// Use OS tempdir so writes never trigger local nodemon file watches on the workspace
const STORE_PATH = process.env.ORDERS_METADATA_PATH ||
  path.join(os.tmpdir(), 'siddiqui_orders_metadata.json');
const SEED_PATH = path.join(__dirname, '../../orders_metadata.json');
const LEGACY_PATH = path.join(__dirname, '../data/orders_metadata.json');

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readStore() {
  try {
    ensureDir();
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
    let seedData = {};
    if (fs.existsSync(SEED_PATH)) {
      seedData = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    } else if (fs.existsSync(LEGACY_PATH)) {
      seedData = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(seedData, null, 2), 'utf8');
    return seedData;
  } catch (err) {
    console.error('[orderStore] Read error:', err.message);
  }
  return {};
}

function writeStore(data) {
  try {
    ensureDir();
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[orderStore] Write error:', err.message);
  }
}

function saveOrderMetadata(orderId, meta) {
  if (!orderId) return;
  const store = readStore();
  store[String(orderId)] = {
    ...(store[String(orderId)] || {}),
    ...meta,
    updatedAt: new Date().toISOString()
  };
  writeStore(store);
}

function getOrderMetadata(orderId) {
  if (!orderId) return null;
  const store = readStore();
  return store[String(orderId)] || null;
}

function findOrderMetadataByToken(token) {
  if (!token) return null;
  const store = readStore();
  const lowerToken = String(token).toLowerCase();
  for (const [orderId, meta] of Object.entries(store)) {
    if (
      meta.download_token === token ||
      meta.stripe_session_id === token ||
      meta.paypal_order_id === token ||
      meta.paypal_capture_id === token ||
      meta.payhip_transaction_id === token ||
      meta.order_number === token ||
      orderId === token ||
      String(meta.order_number || "").toLowerCase() === lowerToken
    ) {
      return { orderId, ...meta };
    }
  }
  return null;
}

function getOrdersByEmail(email) {
  if (!email) return [];
  const store = readStore();
  const lower = String(email).trim().toLowerCase();
  return Object.values(store).filter(
    (o) => o.email && String(o.email).trim().toLowerCase() === lower
  );
}

module.exports = {
  saveOrderMetadata,
  getOrderMetadata,
  findOrderMetadataByToken,
  getOrdersByEmail,
};
