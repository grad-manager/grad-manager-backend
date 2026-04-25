import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { saveProgramsToFirebase } from "../utils/firebaseUtils.js";

puppeteerExtra.use(StealthPlugin());

export async function scrapeMastersPortal() {
  console.log("🌍 Launching browser for MastersPortal...");

  let browser;
  try {
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    await page.goto("https://www.mastersportal.com/search/#q=ci-11|lv-master|tc-EUR&start=0", {
      waitUntil: "networkidle2",
      timeout: 90000,
    });

    await new Promise(resolve => setTimeout(resolve, 8000));


    // Step 1: Get basic list of programs
    const programLinks = await page.$$eval(
      ".search-list-item a, .StudySearchResultCard a",
      (anchors) =>
        anchors
          .map((a) => a.href)
          .filter((href) => href.includes("/studies/"))
          .slice(0, 10) // limit for safety; increase later
    );

    console.log(`🎓 Found ${programLinks.length} program links`);

    const programs = [];
    for (const [index, link] of programLinks.entries()) {
      try {
        console.log(`🔍 Scraping details (${index + 1}/${programLinks.length}): ${link}`);

        const programPage = await browser.newPage();
        await programPage.goto(link, {
          waitUntil: "networkidle2",
          timeout: 90000,
        });
        await programPage.waitForTimeout(6000);

        // Step 2: Extract detailed info
        const data = await programPage.evaluate(() => {
          const getText = (selector) =>
            document.querySelector(selector)?.innerText.trim() || "N/A";

          const getMultipleText = (selector) =>
            Array.from(document.querySelectorAll(selector))
              .map((el) => el.innerText.trim())
              .filter(Boolean);

          return {
            programName:
              getText("h1, .header__title, .course-title") || "N/A",
            schoolName: getText(".provider, .institution, .university-name") || "N/A",
            department: getText(".department, .faculty, .school-name"),
            location: getText(".location, .country-name, .city"),
            tuition: getText(".tuition-fee, .fee-value, .FeesSection__fee"),
            funding: getText(".funding, .scholarship-info, .FundingInfo__content"),
            applicationDeadline:
              getText(".deadline, .ApplicationDeadline, .admission-deadline") || "N/A",
            documentsRequired: getMultipleText(
              ".requirement-list li, .RequirementsSection li"
            ),
            applicationFee:
              getText(".application-fee, .fee-amount, .ApplicationFee") || "N/A",
            greRequirement:
              getText(".gre-requirement, .test-requirements, .GRESection") || "N/A",
            ieltsRequirement:
              getText(".ielts-requirement, .IELTSSection, .language-requirements") || "N/A",
            professors: getMultipleText(".professor, .staff-member, .teacher-name"),
            link: window.location.href,
          };
        });

        programs.push(data);
        await programPage.close();

        // Save after every 5
        if (programs.length % 5 === 0) {
          await saveProgramsToFirebase("mastersportal_programs_detailed", programs);
          programs.length = 0;
        }
      } catch (err) {
        console.error(`❌ Error scraping program ${link}:`, err.message);
      }
    }

    // Save remaining
    if (programs.length > 0) {
      await saveProgramsToFirebase("mastersportal_programs_detailed", programs);
    }

    console.log("✅ MastersPortal detailed scraping completed!");
  } catch (err) {
    console.error("❌ MastersPortal scrape error:", err.message);
  } finally {
    if (browser) await browser.close();
  }
}
