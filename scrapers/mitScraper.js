import puppeteer from "puppeteer";

export async function scrapeMIT() {
  console.log("🎓 Scraping MIT Graduate Programs...");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto("https://gradadmissions.mit.edu/programs", {
      waitUntil: "networkidle2",
    });

    const programs = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".view-content .views-row"));
      return rows.map((row) => ({
        title: row.querySelector(".views-field-title a")?.innerText.trim(),
        link: row.querySelector(".views-field-title a")?.href,
        department: row.querySelector(".views-field-field-school-name")?.innerText.trim(),
        university: "MIT",
      }));
    });

    console.log(`✅ MIT: Found ${programs.length} programs`);
    return programs;
  } catch (error) {
    console.error("❌ MIT scrape error:", error.message);
    return [];
  } finally {
    await browser.close();
  }
}
