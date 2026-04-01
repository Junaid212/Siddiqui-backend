require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

supabase.from('consultations').select('*').order('created_at', { ascending: false }).limit(2).then(res => {
  fs.writeFileSync('d:/Bright Media WORK/siddiqui-backend/server/recent_bookings.json', JSON.stringify(res.data, null, 2));
  console.log('Saved to recent_bookings.json');
});
