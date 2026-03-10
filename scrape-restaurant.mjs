#!/usr/bin/env node
import puppeteer from 'puppeteer';
import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const delay = ms => new Promise(r => setTimeout(r, ms));

// --- Resolve short Google Maps URL to full URL ---
export async function resolveShortUrl(shortUrl) {
  return new Promise((resolve, reject) => {
    const protocol = shortUrl.startsWith('https') ? https : http;
    const req = protocol.get(shortUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        resolve(res.headers.location);
      } else {
        resolve(shortUrl);
      }
      res.destroy();
    });
    req.on('error', reject);
    req.end();
  });
}

export async function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadImage(res.headers.location, filepath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const fileStream = fs.createWriteStream(filepath);
      res.pipe(fileStream);
      fileStream.on('finish', () => { fileStream.close(); resolve(); });
      fileStream.on('error', reject);
    }).on('error', reject);
  });
}

export async function scrapeGoogleMapsPhotos(mapsUrl, outputDir, onProgress) {
  const emit = (data) => {
    console.log(`[scraper] ${data.message || data.stage}`);
    onProgress?.(data);
  };

  emit({ stage: 'launching', message: 'Launching browser...' });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

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
      timeout: 30000
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

    if (outputDir) {
      await page.screenshot({ path: path.join(outputDir, '_debug_listing.png'), fullPage: false });
    }

    const title = await page.title();
    emit({ stage: 'navigating', message: `Found: ${title}` });

    // Click the main photo to enter the photo gallery
    emit({ stage: 'gallery', message: 'Entering photo gallery...' });
    const photoClicked = await page.evaluate(() => {
      const mainImg = document.querySelector('img[decoding="async"][src*="googleusercontent"]');
      if (mainImg) { mainImg.click(); return 'clicked img'; }
      const btns = Array.from(document.querySelectorAll('button'));
      const photoBtn = btns.find(b =>
        b.textContent.includes('photo') ||
        b.textContent.includes('Photo') ||
        b.getAttribute('aria-label')?.includes('photo') ||
        b.getAttribute('aria-label')?.includes('Photo')
      );
      if (photoBtn) { photoBtn.click(); return 'clicked button'; }
      return false;
    });
    await delay(5000);

    if (outputDir) {
      await page.screenshot({ path: path.join(outputDir, '_debug_gallery1.png'), fullPage: false });
    }

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
        emit({ stage: 'scrolling', message: `Scrolling gallery... (${allUrls.size} photos found)`, collected: allUrls.size, scroll: i + 1, totalScrolls });
      }
    }

    // Click on individual photos to load full-res versions
    const photoElements = await page.$$('img[src*="googleusercontent"]');
    const clickTotal = Math.min(photoElements.length, 30);
    emit({ stage: 'clicking', message: `Clicking through ${clickTotal} photos for full resolution...`, total: clickTotal });

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

    if (outputDir) {
      await page.screenshot({ path: path.join(outputDir, '_debug_gallery2.png'), fullPage: false });
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
    emit({ stage: 'scrape_complete', message: `Found ${allUrls.size} unique photos`, collected: allUrls.size });

  } catch (error) {
    console.error('Error:', error.message);
    if (outputDir) {
      await page.screenshot({ path: path.join(outputDir, '_debug_error.png'), fullPage: false });
    }
  } finally {
    await browser.close();
  }

  return Array.from(allUrls);
}

// --- CLI entry point (only runs when executed directly) ---
const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scrape-restaurant.mjs <google-maps-url> [output-dir]');
    console.error('Example: node scrape-restaurant.mjs "https://maps.app.goo.gl/9mUhGXLy2kwNGpDKA" ./public/images/askim');
    process.exit(1);
  }

  const MAPS_URL = args[0];
  const OUTPUT_DIR = args[1] || './public/images/output';

  async function main() {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    let resolvedUrl = MAPS_URL;
    if (MAPS_URL.includes('maps.app.goo.gl') || MAPS_URL.includes('goo.gl')) {
      console.log('Resolving short URL...');
      resolvedUrl = await resolveShortUrl(MAPS_URL);
      console.log(`Resolved to: ${resolvedUrl}`);
    }

    const urls = await scrapeGoogleMapsPhotos(resolvedUrl, OUTPUT_DIR);

    fs.writeFileSync(path.join(OUTPUT_DIR, '_photo_urls.json'), JSON.stringify(urls, null, 2));
    console.log(`\nSaved ${urls.length} URLs to _photo_urls.json`);

    let downloaded = 0;
    for (let i = 0; i < urls.length; i++) {
      const filename = `photo_${i + 1}.jpg`;
      const filepath = path.join(OUTPUT_DIR, filename);
      try {
        await downloadImage(urls[i], filepath);
        const stats = fs.statSync(filepath);
        if (stats.size < 5000) {
          fs.unlinkSync(filepath);
          console.log(`Removed tiny file: ${filename} (${stats.size} bytes)`);
        } else {
          console.log(`Downloaded: ${filename} (${(stats.size / 1024).toFixed(1)} KB)`);
          downloaded++;
        }
      } catch (e) {
        try { fs.unlinkSync(filepath); } catch (_) {}
        console.log(`Failed: ${filename}: ${e.message}`);
      }
    }

    console.log(`\n✅ Downloaded ${downloaded} images to ${OUTPUT_DIR}`);
  }

  main().catch(console.error);
}
