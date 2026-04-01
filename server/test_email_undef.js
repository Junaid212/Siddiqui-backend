const { createEvent } = require("ics");

function generateICS(date, time, email) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);

  const event = {
    title: "Consultation with Siddiqui Digital",
    description: "Your booked consultation meeting",
    start: [year, month, day, hour, minute],
    duration: { hours: 1 },
    organizer: {
      name: "Siddiqui Digital",
      email: undefined // process.env.SMTP_USER might be undefined
    },
    attendees: [{ email }]
  };

  return new Promise((resolve, reject) => {
    createEvent(event, (error, value) => {
      if (error) reject(error);
      resolve(value);
    });
  });
}

generateICS("2026-03-24", "10:30", "test@example.com").then(console.log).catch(console.error);
