import puppeteer from 'puppeteer';
import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';

const OUTPUT_DIR = './public/images';
const delay = ms => new Promise(r => setTimeout(r, ms));

async function downloadImage(url, filepath) {
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

async function deepScrapeGoogleMaps() {
  console.log('=== Deep scraping Google Maps photo gallery ===');
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
    // Go directly to the place
    console.log('Navigating to Google Maps place...');
    await page.goto('https://www.google.com/maps/place/Favorite+Lake+Restaurant/@25.0771938,55.1480007,17z/data=!4m7!3m6!1s0x3e5f6ca8fcc00001:0xe54c88df033596e3!8m2!3d25.0771847!4d55.1479581!10e5!16s%2Fg%2F11b_0f0wl9', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await delay(4000);

    // Accept cookies
    try {
      const btn = await page.$('button[aria-label="Accept all"]');
      if (btn) await btn.click();
      await delay(1000);
    } catch (e) {}

    // Click the main photo to enter the photo gallery
    console.log('Clicking main photo to enter gallery...');
    const photoClicked = await page.evaluate(() => {
      // Try clicking the main photo area
      const mainImg = document.querySelector('img[decoding="async"][src*="googleusercontent"]');
      if (mainImg) { mainImg.click(); return true; }
      // Try the photo button
      const btns = Array.from(document.querySelectorAll('button'));
      const photoBtn = btns.find(b => b.textContent.includes('photo') || b.getAttribute('aria-label')?.includes('photo'));
      if (photoBtn) { photoBtn.click(); return true; }
      return false;
    });
    console.log(`Photo click result: ${photoClicked}`);
    await delay(5000);

    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_gallery1.png'), fullPage: false });

    // Now we should be in the photo gallery. Click "All" tab if available
    console.log('Looking for "All" photos tab...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const allBtn = btns.find(b => b.textContent.trim() === 'All');
      if (allBtn) allBtn.click();
    });
    await delay(3000);

    // Scroll extensively to load all photos
    console.log('Scrolling through gallery to load all photos...');
    for (let i = 0; i < 30; i++) {
      // Try scrolling the main content area
      await page.evaluate(() => {
        // Try various scrollable containers
        const containers = [
          document.querySelector('[role="main"]'),
          document.querySelector('.section-scrollbox'),
          document.querySelector('[class*="gallery"]'),
          document.querySelector('[class*="photos"]'),
        ].filter(Boolean);

        for (const c of containers) {
          c.scrollTop += 1500;
        }
        window.scrollBy(0, 1500);
      });
      await delay(600);

      if (i % 10 === 9) {
        console.log(`  Scrolled ${i + 1} times, collected ${allUrls.size} URLs so far`);
      }
    }

    // Also try clicking on individual photos to load full-res versions
    console.log('Clicking through individual photos...');
    const photoElements = await page.$$('img[src*="googleusercontent"]');
    console.log(`Found ${photoElements.length} photo elements to click through`);

    for (let i = 0; i < Math.min(photoElements.length, 30); i++) {
      try {
        await photoElements[i].click();
        await delay(800);
      } catch (e) {}
    }

    // Also try keyboard navigation (arrow keys) in the gallery
    console.log('Trying keyboard navigation...');
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowRight');
      await delay(800);
    }

    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_gallery2.png'), fullPage: false });

    // Extract all URLs from the DOM too
    const domUrls = await page.evaluate(() => {
      const urls = new Set();
      document.querySelectorAll('img[src*="googleusercontent"]').forEach(img => {
        let src = img.src;
        src = src.replace(/=.*$/, '=w1200-h800-k-no');
        urls.add(src);
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
    console.log(`\nTotal unique URLs collected: ${allUrls.size}`);

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_error2.png'), fullPage: false });
  } finally {
    await browser.close();
  }

  return Array.from(allUrls);
}

// Scrape TripAdvisor
async function scrapeTripAdvisor() {
  console.log('\n=== Scraping TripAdvisor ===');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const urls = [];

  try {
    await page.goto('https://www.tripadvisor.com/Restaurant_Review-g295424-d19814540-Reviews-Favorite-Dubai_Emirate_of_Dubai.html', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await delay(4000);

    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_tripadvisor.png'), fullPage: false });

    // Try to find and click the photos section
    try {
      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button'));
        const photoLink = links.find(l => l.textContent.includes('Photo') || l.textContent.includes('photo'));
        if (photoLink) photoLink.click();
      });
      await delay(3000);
    } catch (e) {}

    // Extract image URLs
    const taUrls = await page.evaluate(() => {
      const urls = new Set();
      document.querySelectorAll('img').forEach(img => {
        const src = img.src || img.dataset?.src || '';
        if (src && !src.includes('svg') && !src.includes('data:') && !src.includes('icon')) {
          // TripAdvisor uses photo-s, photo-o, photo-l for different sizes
          let highRes = src.replace(/photo-s/, 'photo-o').replace(/photo-l/, 'photo-o');
          // Also try to remove size params
          highRes = highRes.replace(/\?w=\d+/, '');
          if (highRes.includes('tripadvisor') || highRes.includes('tacdn')) {
            urls.add(highRes);
          }
        }
      });
      // Check srcset too
      document.querySelectorAll('img[srcset]').forEach(img => {
        const srcset = img.getAttribute('srcset');
        srcset.split(',').forEach(s => {
          const url = s.trim().split(' ')[0];
          if (url && (url.includes('tripadvisor') || url.includes('tacdn'))) {
            urls.add(url.replace(/photo-s/, 'photo-o').replace(/photo-l/, 'photo-o'));
          }
        });
      });
      return Array.from(urls);
    });

    console.log(`Found ${taUrls.length} TripAdvisor images`);
    urls.push(...taUrls);

  } catch (error) {
    console.error('TripAdvisor error:', error.message);
  } finally {
    await browser.close();
  }

  return urls;
}

// Scrape Zomato photos page more deeply
async function deepScrapeZomato() {
  console.log('\n=== Deep scraping Zomato photos ===');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const urls = [];

  try {
    // Go directly to the photos tab
    await page.goto('https://www.zomato.com/dubai/favorite-lake-jumeirah-lake-towers/photos', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await delay(4000);

    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_zomato_photos.png'), fullPage: false });

    // Scroll to load more photos
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await delay(800);
    }

    // Extract all image URLs
    const zomatoUrls = await page.evaluate(() => {
      const urls = new Set();
      document.querySelectorAll('img').forEach(img => {
        const src = img.src || img.dataset?.src || '';
        if (src && (src.includes('zmtcdn') || src.includes('cloudinary') || src.includes('zomato'))) {
          // Try to get high res
          let highRes = src.replace(/\/fit-in\/\d+x\d+\//, '/fit-in/1200x800/');
          urls.add(highRes);
        }
      });
      // Check background images
      document.querySelectorAll('[style*="background"]').forEach(el => {
        const style = el.getAttribute('style') || '';
        const match = style.match(/url\("?([^")\s]+)"?\)/);
        if (match && (match[1].includes('zmtcdn') || match[1].includes('cloudinary'))) {
          urls.add(match[1]);
        }
      });
      return Array.from(urls);
    });

    console.log(`Found ${zomatoUrls.length} Zomato photo URLs`);
    urls.push(...zomatoUrls);

  } catch (error) {
    console.error('Zomato error:', error.message);
  } finally {
    await browser.close();
  }

  return urls;
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Get existing files to avoid duplicates
  const existingFiles = new Set(fs.readdirSync(OUTPUT_DIR));
  let nextIndex = 1;
  existingFiles.forEach(f => {
    const match = f.match(/^extra_(\d+)/);
    if (match) nextIndex = Math.max(nextIndex, parseInt(match[1]) + 1);
  });

  // Run all scrapers
  const gmapsUrls = await deepScrapeGoogleMaps();
  const taUrls = await scrapeTripAdvisor();
  const zomatoUrls = await deepScrapeZomato();

  const allUrls = [...new Set([...gmapsUrls, ...taUrls, ...zomatoUrls])];
  console.log(`\nTotal unique URLs to download: ${allUrls.length}`);

  // Download new images
  let downloaded = 0;
  for (const url of allUrls) {
    const filename = `extra_${nextIndex}.jpg`;
    const filepath = path.join(OUTPUT_DIR, filename);
    try {
      await downloadImage(url, filepath);
      const stats = fs.statSync(filepath);
      if (stats.size < 5000) {
        fs.unlinkSync(filepath);
        console.log(`Removed tiny file: ${filename}`);
      } else {
        console.log(`Downloaded: ${filename} (${(stats.size / 1024).toFixed(1)} KB)`);
        downloaded++;
        nextIndex++;
      }
    } catch (e) {
      try { fs.unlinkSync(filepath); } catch (_) {}
    }
  }

  console.log(`\nNewly downloaded: ${downloaded} images`);

  // Final count
  const allFiles = fs.readdirSync(OUTPUT_DIR).filter(f => !f.startsWith('_') && (f.endsWith('.jpg') || f.endsWith('.png')));
  console.log(`Total images in folder: ${allFiles.length}`);
  allFiles.forEach(f => {
    const stats = fs.statSync(path.join(OUTPUT_DIR, f));
    console.log(`  ${f} (${(stats.size / 1024).toFixed(1)} KB)`);
  });
}

main().catch(console.error);
