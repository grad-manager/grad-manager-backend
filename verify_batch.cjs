// verify_batch.js
// Updated script: fetches only real, verified data (no placeholders)
// Usage:
// node verify_batch.js --input programs_batch12.csv --output programs_verified_batch12.csv --start 0 --limit 50 --concurrency 6 --playwright=true

const fs = require("fs");
const csv = require("fast-csv");
const axios = require("axios");
const cheerio = require("cheerio");
const minimist = require("minimist");
const pLimit = require("p-limit").default;

const args = minimist(process.argv.slice(2), {
  boolean: ["playwright"],
  default: { concurrency: 5, start: 0, limit: 50, playwright: false },
});

const INPUT = args.input;
const OUTPUT = args.output;
const START = parseInt(args.start, 10);
const LIMIT = parseInt(args.limit, 10);
const CONCURRENCY = parseInt(args.concurrency, 10);
const USE_PLAYWRIGHT = !!args.playwright;

let playwright, browser, context;

async function setupPlaywright() {
  if (!USE_PLAYWRIGHT) return;
  try {
    playwright = require("playwright");
    browser = await playwright.chromium.launch({ headless: true });
    context = await browser.newContext();
  } catch (err) {
    console.error("Playwright setup failed:", err.message);
    process.exit(1);
  }
}

async function closePlaywright() {
  if (browser) await browser.close();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
];

function extractDeadlineFromText(text) {
  if (!text || text.length < 10) return null;
  const lower = text.toLowerCase();
  const idx = lower.indexOf("deadline");
  const window = 400;
  const snippet = idx >= 0 ? text.substring(Math.max(0, idx - 100), idx + window) : text.substring(0, window);

  const monthNames =
    "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t)?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const regexes = [
    new RegExp(`${monthNames}\\s+\\d{1,2},?\\s+\\d{4}`, "i"),
    new RegExp(`\\d{1,2}\\s+${monthNames}\\s+\\d{4}`, "i"),
    new RegExp(`Deadline[:\\s]+${monthNames}\\s+\\d{1,2},?\\s+\\d{4}`, "i"),
    new RegExp(`Apply by[:\\s]+${monthNames}\\s+\\d{1,2},?\\s+\\d{4}`, "i"),
  ];

  for (const r of regexes) {
    const m = snippet.match(r);
    if (m && m[0]) return m[0].trim();
  }
  const fallback = text.match(new RegExp(`${monthNames}\\s+\\d{1,2},?\\s+\\d{4}`, "i"));
  return fallback ? fallback[0].trim() : null;
}

function extractFundingFromText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const keywords = ["tuition", "stipend", "scholarship", "studentship", "fellowship", "assistantship", "funded"];
  for (const kw of keywords) {
    const idx = lower.indexOf(kw);
    if (idx >= 0) {
      const start = Math.max(0, idx - 80);
      const end = Math.min(lower.length, idx + 120);
      return text.substring(start, end).replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

function extractDocsFromText(text) {
  if (!text) return [];
  const found = new Set();
  const mapping = [
    { keys: ["cv", "curriculum vitae", "resume"], name: "CV / Resume" },
    { keys: ["statement of purpose", "sop"], name: "Statement of Purpose (SOP)" },
    { keys: ["personal statement"], name: "Personal Statement" },
    { keys: ["letter of recommendation", "recommendation letters", "lor"], name: "Letters of Recommendation" },
    { keys: ["official transcript", "transcript"], name: "Transcript" },
    { keys: ["gre"], name: "GRE" },
    { keys: ["ielts", "toefl"], name: "IELTS/TOEFL" },
    { keys: ["research proposal"], name: "Research Proposal" },
    { keys: ["writing sample"], name: "Writing Sample" },
    { keys: ["portfolio"], name: "Portfolio" },
  ];
  const lower = text.toLowerCase();
  for (const m of mapping) {
    for (const k of m.keys) {
      if (lower.includes(k)) {
        found.add(m.name);
        break;
      }
    }
  }
  return Array.from(found);
}

async function fetchWithAxios(url) {
  try {
    const headers = {
      "User-Agent": userAgents[Math.floor(Math.random() * userAgents.length)],
      "Accept-Language": "en-US,en;q=0.9",
    };
    const res = await axios.get(url, { timeout: 15000, headers });
    if (res && res.status === 200) return res.data;
    return null;
  } catch {
    return null;
  }
}

async function fetchWithPlaywright(url) {
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const content = await page.content();
    await page.close();
    return content;
  } catch {
    return null;
  }
}

async function processRow(row) {
  const result = { ...row };
  const url = row["Application Links"] || row["Application Link"] || row["appLink"];
  if (!url || url.toLowerCase().startsWith("verification_pending")) {
    result.__status = "no_link";
    result.__needsReview = "true";
    return result;
  }

  let html = await fetchWithAxios(url);
  if (!html && USE_PLAYWRIGHT) html = await fetchWithPlaywright(url);
  if (!html) {
    result.__status = "fetch_error";
    result.__needsReview = "true";
    return result;
  }

  const $ = cheerio.load(html);
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  const deadline = extractDeadlineFromText(bodyText);
  const funding = extractFundingFromText(bodyText);
  const docs = extractDocsFromText(bodyText);

  if (deadline) result["Application Deadline"] = deadline;
  if (funding) result["Funding"] = funding;
  if (docs.length > 0) result["Required Document"] = docs.join("; ");

  result.__status = "ok";
  result.__needsReview = (!deadline || !funding || docs.length < 2) ? "true" : "false";
  return result;
}

async function main() {
  await setupPlaywright();
  const rows = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(INPUT)
      .pipe(csv.parse({ headers: true }))
      .on("error", reject)
      .on("data", (r) => rows.push(r))
      .on("end", resolve);
  });

  const slice = rows.slice(START, START + LIMIT);
  console.log(`Verifying ${slice.length} rows (from ${START}) with concurrency ${CONCURRENCY}`);

  const limit = pLimit(CONCURRENCY);
  const tasks = slice.map((r, idx) =>
    limit(async () => {
      const indexGlobal = START + idx;
      try {
        await sleep(300 + Math.random() * 700);
        const processed = await processRow(r);
        processed.__index = indexGlobal;
        return processed;
      } catch (err) {
        return { ...r, __status: "error", __error: String(err), __index: indexGlobal };
      }
    })
  );

  const results = await Promise.all(tasks);
  const outStream = fs.createWriteStream(OUTPUT);
  const csvStream = csv.format({ headers: true });
  csvStream.pipe(outStream);
  for (const row of results) csvStream.write(row);
  csvStream.end();

  await closePlaywright();
  console.log("✅ Verification complete. Results saved to:", OUTPUT);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
