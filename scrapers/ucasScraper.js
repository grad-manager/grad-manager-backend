import fs from "fs";
import path from "path";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { saveProgramsToFirebase } from "../utils/firebaseUtils.js";

puppeteerExtra.use(StealthPlugin());

export async function scrapeUCAS() {
  console.log("🎓 Launching browser for UCAS Postgraduate...");

  let browser;
  try {
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    await page.goto("https://www.ucas.com/explore/subjects", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    console.log("⏳ Waiting for UCAS subject tiles to render...");
    await page.waitForSelector(".ExploreSubjectCard, .ExploreSubjects__Card, .subject-tile", {
      timeout: 30000,
    });

    // Scroll down gradually to trigger all lazy loads
    await page.evaluate(async () => {
      for (let i = 0; i < 15; i++) {
        window.scrollBy(0, 700);
        await new Promise((r) => setTimeout(r, 400));
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 4000));

    const subjects = await page.$$eval(
      ".ExploreSubjectCard, .ExploreSubjects__Card, .subject-tile",
      (tiles) =>
        tiles.map((tile) => ({
          programName:
            tile.querySelector("h3, .ExploreSubjectCard__Title, .subject-tile__title")?.innerText?.trim() ||
            "N/A",
          link: tile.querySelector("a")?.href || "N/A",
          schoolName: "UCAS Postgraduate",
        }))
    );

    if (!subjects.length) {
      console.warn("⚠️ No UCAS subjects found. Dumping HTML for inspection...");
      const htmlContent = await page.content();
      const debugDir = path.resolve("./debug");
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);
      const filePath = path.join(debugDir, "ucas_page_dump.html");
      fs.writeFileSync(filePath, htmlContent, "utf-8");
      console.log(`🧾 HTML saved for debugging: ${filePath}`);
    } else {
      console.log(`✅ Found ${subjects.length} UCAS subjects!`);
      await saveProgramsToFirebase("ucas_programs", subjects);
    }
  } catch (err) {
    console.error("❌ UCAS scrape error:", err.message);
  } finally {
    if (browser) await browser.close();
  }
}