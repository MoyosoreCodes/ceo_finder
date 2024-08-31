const puppeteer = require('puppeteer-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(stealthPlugin());
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// Function to perform a Google search with site-specific filters
const searchOnGoogle = async (page, query) => {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Check if CAPTCHA or bot check page is displayed
    const isCaptcha = await page.evaluate(() => document.querySelector('.captcha') !== null);
    if (isCaptcha) {
      return { error: `CAPTCHA or bot check detected for query: ${query}`, url };
    }

    const results = await page.evaluate((query) => {
      const resultItems = document.querySelectorAll('.g');
      const resultsArray = [];
      resultItems.forEach(item => {
        const text = item.innerText;
        const sentences = text.split(/[.!?]\s+/);
        // Only include sentences that contain the keyword
        if (sentences.some(sentence => sentence.toLowerCase().includes(query.split(' ')[0].toLowerCase()))) {
          resultsArray.push({
            sentence: sentences.join(' ').trim(),
            url: item.querySelector('a') ? item.querySelector('a').href : ''
          });
        }
      });
      return resultsArray;
    }, query);

    return { results: results.slice(0, 3), url }; // Limit to top 3 results
  } catch (error) {
    return { error: `Error during search for ${query}: ${error.message}`, url };
  }
};

// Function to perform searches for specific sites using Google
const searchCEO = async (emailDomain) => {
  const domainType = emailDomain.split('.')[1];

  const domainKeywords = {
    'org': ['Executive Director', 'President'],
    'edu': ['President'],
    'net': ['General Manager', 'Managing Partner'],
    'com': ['CEO', 'Founder'],
    'us': ['General Manager'],
    'info': ['Editor in Chief']
  };

  const keywords = domainKeywords[domainType] || [
    'CEO', 'Co-founder', 'Founder', 'President', 'Chief Executive Officer', 'Executive Director', 'Brooker',
    'Owner', 'General Manager', 'Editor in Chief', 'Chief Editor', 'Managing Partner', 'Superintendent', 'Head of School'
  ];

  const searchQueries = keywords.map(keyword => `current ${keyword.toLowerCase()} of ${emailDomain} 2024`);

  // Specific site filters for Google search
  const siteFilters = [
    'crunchbase.com',
    'linkedin.com',
    // 'site:wikipedia.org'
  ];

  const googleQueries = searchQueries.flatMap(query => 
    siteFilters.map(filter => `${query} ${filter}`)
  );

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const searchResultsPromises = googleQueries.map(query => searchOnGoogle(page, query));
  const searchResults = await Promise.all(searchResultsPromises);

  const allResults = {
    found: {},
    notFound: {},
    failed: {}
  };

  googleQueries.forEach((query, index) => {
    const result = searchResults[index];
    if (result.error) {
      allResults.failed[query] = { error: result.error, url: result.url };
    } else if (result.results.length > 0) {
      allResults.found[query] = result.results;
    } else {
      allResults.notFound[query] = ['No results found.'];
    }
  });

  await page.close();
  await browser.close();
  return allResults;
};

function extractEmailDomains() {
  const fileContent = fs.readFileSync('input.txt', 'utf-8').split('\r\n').filter(Boolean);
  const domains = [];
  if (fileContent.length) {
    for (const data of fileContent) {
      const items = data.split('@');
      const domain = items[items.length - 1];
      domains.push(domain);
    }
  }
  return domains;
}

if (isMainThread) {
  async function main() {
    const domains = extractEmailDomains();
    const chunkSize = Math.ceil(domains.length / 4);
    const results = {
      found: {},
      notFound: {},
      failed: {}
    };

    const chunks = [];
    for (let i = 0; i < domains.length; i += chunkSize) {
      chunks.push(domains.slice(i, i + chunkSize));
    }

    const workerPromises = chunks.map((chunk) => {
      return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: chunk });

        worker.on('message', (message) => resolve(message));
        worker.on('error', (error) => reject(error));
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });
      });
    });

    const workerResults = await Promise.all(workerPromises);
    workerResults.forEach(result => {
      results.found = { ...results.found, ...result.found };
      results.notFound = { ...results.notFound, ...result.notFound };
      results.failed = { ...results.failed, ...result.failed };
    });

    // Write results to different files
    fs.writeFileSync('found_results.txt', formatResults(results.found));
    fs.writeFileSync('not_found_results.txt', formatResults(results.notFound));
    fs.writeFileSync('failed_searches.txt', formatResults(results.failed));

    console.log('Results saved to found_results.txt, not_found_results.txt, and failed_searches.txt');
  }

  function formatResults(results) {
    return Object.entries(results).map(([query, entries]) => {
      if (entries.error) {
        return `Query: ${query}\nError: ${entries.error}\nSearch URL: ${entries.url}\n`;
      } 
      if (entries.length === 1 && entries[0] === 'No results found.') {
        return `Query: ${query}\nNo results found.\n`;
      }
      return `Query: ${query}\nTop 3 Results:\n${entries.map(entry => `${entry.sentence}\nURL: ${entry.url}`).join('\n')}\n`;
    }).join('\n\n');
  }

  main().catch(console.error);
} else {
  (async () => {
    try {
      const domains = workerData;
      const resultPromises = domains.map(domain => searchCEO(domain));
      const resultsArray = await Promise.all(resultPromises);
      const results = resultsArray.reduce((acc, result) => {
        acc.found = { ...acc.found, ...result.found };
        acc.notFound = { ...acc.notFound, ...result.notFound };
        acc.failed = { ...acc.failed, ...result.failed };
        return acc;
      }, { found: {}, notFound: {}, failed: {} });
      parentPort.postMessage(results);
    } catch (error) {
      parentPort.postMessage({ failed: { [`Error processing domains: ${error.message}`]: { error: error.message } } });
    }
  })();
}

