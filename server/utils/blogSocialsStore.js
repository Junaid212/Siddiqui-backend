/**
 * blogSocialsStore.js — Reader for Blog social links in main backend
 */
const fs = require('fs');
const path = require('path');

const ADMIN_STORE_FILE = path.join(__dirname, '../../../siddique-admin/server/src/data/blog_socials.json');
const LOCAL_STORE_FILE = path.join(__dirname, '../data/blog_socials.json');

function readAll() {
  try {
    if (fs.existsSync(ADMIN_STORE_FILE)) {
      return JSON.parse(fs.readFileSync(ADMIN_STORE_FILE, 'utf8')) || {};
    }
  } catch (e) {}

  try {
    if (fs.existsSync(LOCAL_STORE_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_STORE_FILE, 'utf8')) || {};
    }
  } catch (e) {}

  return {};
}

function getSocials(blogId) {
  if (!blogId) return { linkedin_url: null, instagram_url: null, facebook_url: null };
  const all = readAll();
  const entry = all[String(blogId)] || {};
  return {
    linkedin_url: entry.linkedin_url ? String(entry.linkedin_url).trim() : null,
    instagram_url: entry.instagram_url ? String(entry.instagram_url).trim() : null,
    facebook_url: entry.facebook_url ? String(entry.facebook_url).trim() : null,
  };
}

module.exports = {
  getSocials,
  readAll,
};
