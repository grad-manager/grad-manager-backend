// merge-verified.cjs
const fs = require('fs');
const path = require('path');
const csv = require('fast-csv');

const outFile = 'programs_verified_full.csv';
const files = fs.readdirSync('.').filter(f => f.startsWith('verified_batch_') && f.endsWith('.csv')).sort();

const writeStream = fs.createWriteStream(outFile);
const csvStream = csv.format({ headers: true });
csvStream.pipe(writeStream);

(async () => {
  for (const f of files) {
    await new Promise((resolve, reject) => {
      fs.createReadStream(f)
        .pipe(csv.parse({ headers: true }))
        .on('error', reject)
        .on('data', (row) => csvStream.write(row))
        .on('end', resolve);
    });
    console.log('Appended', f);
  }
  csvStream.end();
  console.log('Merged into', outFile);
})();
