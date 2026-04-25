import { scrapeMastersPortal } from "./mastersportalScraper.js";
import { scrapeUCAS } from "./ucasScraper.js";

export async function runAllScrapers() {
  console.log("🚀 Running all global graduate program scrapers...");

  await Promise.allSettled([
    scrapeMastersPortal(),
    scrapeUCAS(),
  ]);

  console.log("✅ All scrapers completed!");
}
