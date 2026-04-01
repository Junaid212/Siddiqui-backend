require('dotenv').config({ path: 'd:/Bright Media WORK/siddiqui-backend/server/.env' });
const generateICS = require('d:/Bright Media WORK/siddiqui-backend/server/utils/createCalendarInvite');

async function testICS() {
  try {
    const icsFile = await generateICS("2026-03-19", "10:00", "mohadjunaid212@gmail.com");
    console.log("ICS generated successfully:");
    console.log(icsFile);
  } catch (error) {
    console.error("ICS generation error:", error);
  }
}

testICS();
