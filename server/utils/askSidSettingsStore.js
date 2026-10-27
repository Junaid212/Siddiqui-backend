/**
 * askSidSettingsStore.js — Settings reader for Ask SID in main backend
 * Supports Supabase table 'ask_sid_settings' with file fallback.
 */
const fs = require('fs');
const path = require('path');
const supabase = require('../config/supabaseClient');

const DATA_DIR = path.join(__dirname, '../data');
const SETTINGS_FILE = path.join(DATA_DIR, 'ask_sid_settings.json');
const ADMIN_SETTINGS_FILE = path.join(__dirname, '../../../siddique-admin/server/data/ask_sid_settings.json');

const DEFAULT_SETTINGS = {
  askSidEnabled: true,
  publicDemoEnabled: true,
  demoQuestionLimit: 1,
  fullAccessProductId: "04b84648-3609-4b31-9ded-2486bacf1e74",
  onlineEditionProductId: "prod_online_reading_001",
  upgradeCtaText: "Unlock Full Ask SID with the Digital Companion Edition ($49.99)",
  upgradeUrl: "/publications/marketing-reclassified",
  advisoryCtaEnabled: true,
  advisoryUrl: "/consultation",
  updatedAt: new Date().toISOString()
};

function readLocalSettings() {
  try {
    if (fs.existsSync(ADMIN_SETTINGS_FILE)) {
      const raw = fs.readFileSync(ADMIN_SETTINGS_FILE, 'utf8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {}

  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {}

  return { ...DEFAULT_SETTINGS };
}

async function getAskSidSettings() {
  try {
    const { data, error } = await supabase
      .from('ask_sid_settings')
      .select('*')
      .eq('id', 'default')
      .maybeSingle();

    if (!error && data && data.settings) {
      return { ...DEFAULT_SETTINGS, ...data.settings };
    }
  } catch (e) {}

  return readLocalSettings();
}

module.exports = {
  DEFAULT_SETTINGS,
  getAskSidSettings,
};
