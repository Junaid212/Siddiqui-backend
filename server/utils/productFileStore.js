const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '../data/product_files.json');

// Ensure directory exists
function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Read current store
function readStore() {
  try {
    ensureDir();
    if (fs.existsSync(STORE_PATH)) {
      const data = fs.readFileSync(STORE_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[productFileStore] Read error:', err.message);
  }
  return {};
}

// Write to store
function writeStore(data) {
  try {
    ensureDir();
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[productFileStore] Write error:', err.message);
  }
}

/**
 * Save product file mapping permanently
 */
function setProductFile(productId, filePath, format = 'PDF') {
  if (!productId) return;
  const store = readStore();
  store[String(productId)] = {
    filePath,
    format: format || 'PDF',
    updatedAt: new Date().toISOString()
  };
  writeStore(store);
}

/**
 * Get product file mapping
 */
function getProductFile(productId) {
  if (!productId) return null;
  const store = readStore();
  return store[String(productId)] || null;
}

/**
 * Get all product file mappings
 */
function getAllProductFiles() {
  return readStore();
}

module.exports = {
  setProductFile,
  getProductFile,
  getAllProductFiles,
};
