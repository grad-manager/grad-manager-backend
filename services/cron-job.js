import cron from "node-cron";
import { runAllScrapers } from "../scrapers/index.js";

const startCronJob = () => {
  console.log("🕒 Starting graduate program cron job...");

  // Every Monday at 2 AM
  cron.schedule("0 2 * * 1", async () => {
    console.log("🚀 Running weekly graduate program update...");
    try {
      await runAllScrapers();
      console.log("✅ Weekly update completed successfully.");
    } catch (error) {
      console.error("❌ Cron job failed:", error);
    }
  });

  console.log("✅ Cron job scheduled successfully.");
};

export default startCronJob;
