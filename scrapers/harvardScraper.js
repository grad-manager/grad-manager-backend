import puppeteer from "puppeteer";

export async function scrapeHarvard() {
  console.log("🎓 Scraping Harvard Graduate Programs...");
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto("https://gsas.harvard.edu/programs", { waitUntil: "networkidle2" });

    const programs = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".views-row"));
      return items.map((el) => ({
        title: el.querySelector(".views-field-title a")?.innerText.trim(),
        link: el.querySelector(".views-field-title a")?.href,
        department: el.querySelector(".views-field-field-department")?.innerText.trim(),
        university: "Harvard University",
      }));
    });

    console.log(`✅ Harvard: Found ${programs.length} programs`);
    return programs;
  } catch (error) {
    console.error("❌ Harvard scrape error:", error.message);
    return [];
  } finally {
    await browser.close();
  }
}
