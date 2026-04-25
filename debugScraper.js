import { chromium } from 'playwright';

const debugScraper = async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();

    console.log('Starting network logging...');

    page.on('response', async response => {
        try {
            // Log the URL and a snippet of the response text
            const url = response.url();
            const status = response.status();
            console.log(`URL: ${url}, Status: ${status}`);
            
            // Log a part of the response body for JSON content
            if (response.headers()['content-type']?.includes('application/json')) {
                const text = await response.text();
                // Log the first 200 characters to avoid clutter
                console.log('Response Body Snippet:', text.substring(0, 200));
            }
        } catch (error) {
            // Ignore errors for non-text responses (like images)
        }
    });

    try {
        const url = 'https://www.mastersportal.com/search/scholarships/master/united-states';
        await page.goto(url, { waitUntil: 'networkidle' });
        console.log('Page loaded. Check the log for API calls.');
    } catch (error) {
        console.error('An error occurred:', error);
    } finally {
        await browser.close();
    }
};

debugScraper();