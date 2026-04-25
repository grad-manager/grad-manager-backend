import puppeteer from "puppeteer";

export async function scrapeTopUniversities() {
  console.log("🎓 Scraping TopUniversities graduate rankings...");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto("https://www.topuniversities.com/university-rankings/world-university-rankings/2025", {
      waitUntil: "networkidle2",
      timeout: 120000,
    });

    const programs = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".rankings-table__row"));
      return rows.slice(0, 50).map((row) => ({
        rank: row.querySelector(".rankings-table__rank")?.innerText.trim(),
        university: row.querySelector(".rankings-table__title a")?.innerText.trim(),
        link: row.querySelector(".rankings-table__title a")?.href,
      }));
    });

    console.log(`✅ TopUniversities: Found ${programs.length} entries`);
    return programs;
  } catch (error) {
    console.error("❌ TopUniversities scrape error:", error.message);
    return [];
  } finally {
    await browser.close();
  }
}
