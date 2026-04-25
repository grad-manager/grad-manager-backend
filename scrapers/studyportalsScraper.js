const { chromium } = require('playwright');
const mongoose = require('mongoose');
const Program = require('../models/Program'); // We'll create this in the next step

async function runScraper() {
  console.log('Starting StudyPortals scraper...');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  // Navigate to a search page (example)
  await page.goto('https://www.studyportals.com/bachelors/masters/phd-doctorate/?country_id=233&study_level=3');
  
  // Wait for the results container to load
  await page.waitForSelector('.program-list-item');

  const scrapedPrograms = await page.$$eval('.program-list-item', programs => {
    return programs.map(program => {
      const schoolName = program.querySelector('.school-name').innerText;
      const programName = program.querySelector('.program-title').innerText;
      const deadlineText = program.querySelector('.deadline-info').innerText;
      
      return {
        schoolName,
        programName,
        deadline: new Date(deadlineText), // You'll need to parse this properly
        source: 'StudyPortals'
      };
    });
  });

  await browser.close();
  
  // Save the scraped data to MongoDB
  for (const program of scrapedPrograms) {
    try {
      const newProgram = new Program(program);
      await newProgram.save();
    } catch (err) {
      console.error('Error saving program:', err);
    }
  }

  console.log(`Scraper finished. Saved ${scrapedPrograms.length} programs.`);
}

module.exports = runScraper;