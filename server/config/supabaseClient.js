const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Load environment from server/.env, then fallback to root .env
require('dotenv').config({ path: path.join(__dirname, '../.env') });
if (!process.env.SUPABASE_URL) {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('[supabaseClient] Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE missing.');
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
