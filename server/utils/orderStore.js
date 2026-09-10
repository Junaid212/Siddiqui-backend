const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '../data/orders_metadata.json');

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
  for (const [orderId, meta] of Object.entries(store)) {
    if (meta.download_token === token || meta.stripe_session_id === token || orderId === token) {
      return { orderId, ...meta };
    }
  }
  return null;
}

module.exports = {
  saveOrderMetadata,
  getOrderMetadata,
  findOrderMetadataByToken,
};
