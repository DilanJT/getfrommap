import puppeteer from '@cloudflare/puppeteer';

const delay = ms => new Promise(r => setTimeout(r, ms));

/**
 * Resolve a short Google Maps URL (goo.gl) to its full URL using fetch with manual redirect.
 */
export async function resolveShortUrl(shortUrl) {
  const resp = await fetch(shortUrl, { redirect: 'manual' });
  const location = resp.headers.get('location');
  return location || shortUrl;
}

/**
 * Scrape Google Maps photos using Cloudflare Browser Rendering.
 * @param {object} browserBinding - The env.MYBROWSER binding
 * @param {string} mapsUrl - The Google Maps URL to scrape
 * @param {function} onProgress - Callback for progress events
 * @returns {string[]} Array of image URLs
 */
export async function scrapeGoogleMapsPhotos(browserBinding, mapsUrl, onProgress) {
  const emit = (data) => {
    onProgress?.(data);
  };

  emit({ stage: 'launching', message: 'Launching browser...' });

  const browser = await puppeteer.launch(browserBinding);
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const allUrls = new Set();

  // Intercept all googleusercontent image loads
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('googleusercontent.com') && response.status() === 200) {
      const ct = response.headers()['content-type'] || '';
      if (ct.includes('image')) {
        const baseUrl = url.replace(/=.*$/, '=w1200-h800-k-no');
        allUrls.add(baseUrl);
      }
    }
  });

  try {
    emit({ stage: 'navigating', message: 'Navigating to Google Maps...' });
    await page.goto(mapsUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await delay(4000);

    // Accept cookies if dialog appears
    try {
      const acceptBtn = await page.$('button[aria-label="Accept all"]');
      if (acceptBtn) await acceptBtn.click();
      await delay(1000);
    } catch (e) {}

    // If we landed on a search results page, click the first result
    try {
      const feed = await page.$('[role="feed"] > div');
      if (feed) {
        emit({ stage: 'navigating', message: 'Clicking first search result...' });
        await feed.click();
        await delay(4000);
      }
    } catch (e) {}

    const title = await page.title();
    emit({ stage: 'navigating', message: `Found: ${title}` });

    // Click the main photo to enter the photo gallery
    emit({ stage: 'gallery', message: 'Entering photo gallery...' });
    await page.evaluate(() => {
      const mainImg = document.querySelector('img[decoding="async"][src*="googleusercontent"]');
      if (mainImg) { mainImg.click(); return; }
      const btns = Array.from(document.querySelectorAll('button'));
      const photoBtn = btns.find(
        b =>
          b.textContent.includes('photo') ||
          b.textContent.includes('Photo') ||
          b.getAttribute('aria-label')?.includes('photo') ||
          b.getAttribute('aria-label')?.includes('Photo')
      );
      if (photoBtn) photoBtn.click();
    });
    await delay(5000);

    // Click "All" photos tab if available
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const allBtn = btns.find(b => b.textContent.trim() === 'All');
      if (allBtn) allBtn.click();
    });
    await delay(3000);

    // Scroll extensively to load all photos
    const totalScrolls = 30;
    for (let i = 0; i < totalScrolls; i++) {
      await page.evaluate(() => {
        const containers = [
          document.querySelector('[role="main"]'),
          document.querySelector('.section-scrollbox'),
          document.querySelector('[class*="gallery"]'),
          document.querySelector('[class*="photos"]'),
        ].filter(Boolean);
        for (const c of containers) c.scrollTop += 1500;
        window.scrollBy(0, 1500);
      });
      await delay(600);

      if (i % 5 === 4) {
        emit({
          stage: 'scrolling',
          message: `Scrolling gallery... (${allUrls.size} photos found)`,
          collected: allUrls.size,
          scroll: i + 1,
          totalScrolls,
        });
      }
    }

    // Click on individual photos to load full-res versions
    const photoElements = await page.$$('img[src*="googleusercontent"]');
    const clickTotal = Math.min(photoElements.length, 30);
    emit({
      stage: 'clicking',
      message: `Clicking through ${clickTotal} photos for full resolution...`,
      total: clickTotal,
    });

    for (let i = 0; i < clickTotal; i++) {
      try {
        await photoElements[i].click();
        await delay(800);
      } catch (e) {}
    }

    // Keyboard navigation through gallery
    emit({ stage: 'navigating_photos', message: 'Navigating through photo gallery...' });
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('ArrowRight');
      await delay(800);
    }

    // Extract all URLs from DOM as well
    const domUrls = await page.evaluate(() => {
      const urls = new Set();
      document.querySelectorAll('img[src*="googleusercontent"]').forEach(img => {
        urls.add(img.src.replace(/=.*$/, '=w1200-h800-k-no'));
      });
      document.querySelectorAll('[style*="googleusercontent"]').forEach(el => {
        const style = el.getAttribute('style');
        const match = style.match(/url\("?([^")\s]+googleusercontent[^")\s]+)"?\)/);
        if (match) {
          urls.add(match[1].replace(/=.*$/, '=w1200-h800-k-no'));
        }
      });
      return Array.from(urls);
    });

    domUrls.forEach(u => allUrls.add(u));
    emit({
      stage: 'scrape_complete',
      message: `Found ${allUrls.size} unique photos`,
      collected: allUrls.size,
    });
  } catch (error) {
    emit({ stage: 'error', message: `Scraper error: ${error.message}` });
  } finally {
    await browser.close();
  }

  return Array.from(allUrls);
}
