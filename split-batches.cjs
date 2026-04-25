// split-batches.cjs
const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");

// ---- Config ----
const INPUT_FILE = "programs_500_scaffold_for_verification.csv";
const BATCH_SIZE = 50;
const OUTPUT_DIR = "batches";

// ---- Main ----
(async () => {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR);
    }

    const csvData = fs.readFileSync(INPUT_FILE, "utf8");

    // Parse CSV into rows
    const parsed = Papa.parse(csvData, { header: true });
    const rows = parsed.data.filter((r) => Object.keys(r).length > 1); // drop empty rows

    console.log(`Total rows: ${rows.length}`);
    console.log(`Splitting into batches of ${BATCH_SIZE}...`);

    let batchCount = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      batchCount++;
      const batchRows = rows.slice(i, i + BATCH_SIZE);

      const csvOut = Papa.unparse(batchRows);
      const outPath = path.join(OUTPUT_DIR, `batch_${batchCount}.csv`);
      fs.writeFileSync(outPath, csvOut, "utf8");
      console.log(`✅ Wrote ${batchRows.length} rows to ${outPath}`);
    }

    console.log(`Done. Total batches: ${batchCount}`);
  } catch (err) {
    console.error("Error splitting:", err);
  }
})();
