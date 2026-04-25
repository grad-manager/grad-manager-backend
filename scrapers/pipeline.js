const mongoose = require('mongoose');
const cron = require('node-cron');
const runScraper = require('./studyportalsScraper');
const callDaadApi = require('./daadApi');

async function connectToDbAndRun() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/grad-app-tracker';

  try {
    // Add a connection timeout to prevent hanging
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      connectTimeoutMS: 5000, // Timeout after 5 seconds
    });
    console.log('MongoDB connected for pipeline.');

    // Run the data acquisition scripts
    await runScraper();
    await callDaadApi();

  } catch (err) {
    console.error('Pipeline failed:', err);
    // Explicitly exit the process so the script doesn't hang
    process.exit(1); 
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB disconnected.');
  }
}

// Schedule the pipeline to run once every month (on the first day at midnight)
cron.schedule('0 0 1 * *', () => {
  console.log('Running data pipeline via cron job...');
  connectToDbAndRun();
});

// To test it once, you can uncomment this line:
// connectToDbAndRun();