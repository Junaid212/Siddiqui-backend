const http = require('http');

const data = JSON.stringify({
  userId: null,
  name: "Test User",
  email: "no-reply@siddiqui.digital",
  phone: "1234567890",
  message: "Test message",
  date: "2026-03-24",
  time: "11:00"
});

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/consultation/book',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', d => { body += d; });
  res.on('end', () => {
    console.log("Status:", res.statusCode);
    console.log("Response:", body);
  });
});

req.on('error', (e) => {
  console.error("Error:", e);
});

req.write(data);
req.end();
