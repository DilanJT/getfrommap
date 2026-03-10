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
      const fileStream = fs.createWriteStream(filepath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });
      fileStream.on('error', reject);
    }).on('error', reject);
  });
}

async function scrapeGoogleMapsPhotos() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    console.log('Navigating to Google Maps...');
    await page.goto('https://www.google.com/maps/search/Favorite+Lake+Restaurant+JLT+Dubai', {
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

    // Click on the first result
    console.log('Looking for the restaurant listing...');
    try {
      await page.waitForSelector('[role="feed"] > div', { timeout: 10000 });
      const firstResult = await page.$('[role="feed"] > div:first-child');
      if (firstResult) {
        await firstResult.click();
        await delay(4000);
      }
    } catch (e) {
      console.log('No feed found, might already be on the listing page');
    }

    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_listing.png'), fullPage: false });
    console.log('Saved debug screenshot of listing');

    // Click on the main photo or "All photos" button
    console.log('Looking for photos section...');
    const photoSelectors = [
      'button[aria-label*="photo"]',
      'button[aria-label*="Photo"]',
      'button[jsaction*="photo"]',
      '[data-photo-index="0"]',
      'img[decoding="async"][src*="googleusercontent"]',
      '.aoRNLd',
    ];

    let clicked = false;
    for (const sel of photoSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          console.log(`Clicked photo element: ${sel}`);
          clicked = true;
          await delay(4000);
          break;
        }
      } catch (e) {}
    }

    if (!clicked) {
      console.log('Trying to click any main image...');
      await page.evaluate(() => {
        const imgs = document.querySelectorAll('img[src*="googleusercontent"]');
        if (imgs.length > 0) imgs[0].click();
      });
      await delay(4000);
    }

    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_photos.png'), fullPage: false });
    console.log('Saved debug screenshot of photos view');

    // Try to find and click "All" tab
    try {
      const allTab = await page.$('button[aria-label="All"]');
      if (allTab) {
        await allTab.click();
        await delay(2000);
      }
    } catch (e) {}

    // Scroll to load more photos
    console.log('Scrolling to load more photos...');
    for (let i = 0; i < 15; i++) {
      await page.evaluate(() => {
        const scrollable = document.querySelector('[role="main"]') || document.querySelector('.section-scrollbox');
        if (scrollable) {
          scrollable.scrollTop += 1000;
        } else {
          window.scrollBy(0, 1000);
        }
      });
      await delay(800);
    }

    // Extract all googleusercontent image URLs
    console.log('Extracting image URLs...');
    const imageUrls = await page.evaluate(() => {
      const urls = new Set();
      const imgs = document.querySelectorAll('img[src*="googleusercontent"]');
      imgs.forEach(img => {
        let src = img.src;
        if (src.includes('=s') || src.includes('=w') || src.includes('=h')) {
          src = src.replace(/=.*$/, '=w1200-h800-k-no');
        }
        urls.add(src);
      });

      // Also check background images
      const allElements = document.querySelectorAll('[style*="googleusercontent"]');
      allElements.forEach(el => {
        const style = el.getAttribute('style');
        const match = style.match(/url\("?([^")\s]+googleusercontent[^")\s]+)"?\)/);
        if (match) {
          let src = match[1].replace(/=.*$/, '=w1200-h800-k-no');
          urls.add(src);
        }
      });

      return Array.from(urls);
    });

    console.log(`Found ${imageUrls.length} image URLs from Google Maps`);
    const currentUrl = page.url();
    console.log(`Current URL: ${currentUrl}`);

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const filename = `google_photo_${i + 1}.jpg`;
      const filepath = path.join(OUTPUT_DIR, filename);
      try {
        await downloadImage(url, filepath);
        console.log(`Downloaded: ${filename}`);
      } catch (e) {
        console.log(`Failed to download ${filename}: ${e.message}`);
      }
    }

    fs.writeFileSync(path.join(OUTPUT_DIR, '_photo_urls.json'), JSON.stringify(imageUrls, null, 2));
    return imageUrls;

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_error.png'), fullPage: false });
  } finally {
    await browser.close();
  }
}

// Try Google Images search
async function scrapeFromGoogleImages() {
  console.log('\n--- Trying Google Images search ---');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    await page.goto('https://www.google.com/search?q=Favorite+Lake+Restaurant+JLT+Dubai&tbm=isch', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await delay(3000);

    // Accept cookies
    try {
      const btn = await page.$('button[id="L2AGLb"]');
      if (btn) await btn.click();
      await delay(1000);
    } catch (e) {}

    const googleImageUrls = await page.evaluate(() => {
      const urls = new Set();
      const imgs = document.querySelectorAll('img[src*="encrypted"]');
      imgs.forEach(img => {
        if (img.src && img.naturalWidth > 100) {
          urls.add(img.src);
        }
      });
      const allImgs = document.querySelectorAll('img[data-src]');
      allImgs.forEach(img => {
        if (img.dataset.src) urls.add(img.dataset.src);
      });
      return Array.from(urls);
    });

    console.log(`Found ${googleImageUrls.length} Google Image results`);

    for (let i = 0; i < Math.min(googleImageUrls.length, 20); i++) {
      const url = googleImageUrls[i];
      const filename = `google_img_${i + 1}.jpg`;
      const filepath = path.join(OUTPUT_DIR, filename);
      try {
        await downloadImage(url, filepath);
        console.log(`Downloaded: ${filename}`);
      } catch (e) {
        console.log(`Failed: ${filename}: ${e.message}`);
      }
    }
  } catch (error) {
    console.error('Error in Google Images search:', error.message);
  } finally {
    await browser.close();
  }
}

// Try scraping from Zomato
async function scrapeFromZomato() {
  console.log('\n--- Trying Zomato ---');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    await page.goto('https://www.zomato.com/dubai/favorite-lake-jumeirah-lake-towers', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await delay(3000);

    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_zomato.png'), fullPage: false });

    const zomatoImageUrls = await page.evaluate(() => {
      const urls = new Set();
      const imgs = document.querySelectorAll('img[src*="res.cloudinary"], img[src*="b.zmtcdn"]');
      imgs.forEach(img => {
        let src = img.src;
        // Try to get higher res version
        src = src.replace(/\/fit-in\/\d+x\d+\//, '/fit-in/1200x800/');
        src = src.replace(/\?.*$/, '');
        if (src.includes('zmtcdn') || src.includes('cloudinary')) {
          urls.add(src);
        }
      });
      // Also check data-src and srcset
      document.querySelectorAll('img[data-src*="zmtcdn"], img[data-src*="cloudinary"]').forEach(img => {
        urls.add(img.dataset.src);
      });
      document.querySelectorAll('source[srcset*="zmtcdn"], source[srcset*="cloudinary"]').forEach(el => {
        const srcset = el.getAttribute('srcset');
        if (srcset) {
          srcset.split(',').forEach(s => {
            const url = s.trim().split(' ')[0];
            if (url) urls.add(url);
          });
        }
      });
      return Array.from(urls);
    });

    console.log(`Found ${zomatoImageUrls.length} Zomato images`);

    for (let i = 0; i < zomatoImageUrls.length; i++) {
      const url = zomatoImageUrls[i];
      const filename = `zomato_photo_${i + 1}.jpg`;
      const filepath = path.join(OUTPUT_DIR, filename);
      try {
        await downloadImage(url, filepath);
        console.log(`Downloaded: ${filename}`);
      } catch (e) {
        console.log(`Failed: ${filename}: ${e.message}`);
      }
    }
  } catch (error) {
    console.error('Error scraping Zomato:', error.message);
  } finally {
    await browser.close();
  }
}

// Try 2GIS
async function scrapeFrom2GIS() {
  console.log('\n--- Trying 2GIS ---');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  try {
    await page.goto('https://2gis.ae/dubai/firm/70000001020317124', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await delay(4000);

    // Try clicking photos section
    try {
      const photosTab = await page.$('[class*="photo"]');
      if (photosTab) {
        await photosTab.click();
        await delay(2000);
      }
    } catch (e) {}

    await page.screenshot({ path: path.join(OUTPUT_DIR, '_debug_2gis.png'), fullPage: false });

    const twoGisUrls = await page.evaluate(() => {
      const urls = new Set();
      document.querySelectorAll('img').forEach(img => {
        const src = img.src || img.dataset?.src || '';
        if (src && !src.includes('svg') && !src.includes('data:') && (img.naturalWidth > 100 || img.width > 100)) {
          urls.add(src);
        }
      });
      // Check background images
      document.querySelectorAll('[style*="background-image"]').forEach(el => {
        const style = el.getAttribute('style');
        const match = style.match(/url\("?([^")\s]+)"?\)/);
        if (match && !match[1].includes('svg') && !match[1].includes('data:')) {
          urls.add(match[1]);
        }
      });
      return Array.from(urls);
    });

    console.log(`Found ${twoGisUrls.length} 2GIS images`);

    for (let i = 0; i < twoGisUrls.length; i++) {
      const url = twoGisUrls[i];
      const filename = `2gis_photo_${i + 1}.jpg`;
      const filepath = path.join(OUTPUT_DIR, filename);
      try {
        await downloadImage(url, filepath);
        console.log(`Downloaded: ${filename}`);
      } catch (e) {
        console.log(`Failed: ${filename}: ${e.message}`);
      }
    }
  } catch (error) {
    console.error('Error scraping 2GIS:', error.message);
  } finally {
    await browser.close();
  }
}

// Try to intercept network requests for images on Google Maps
async function scrapeViaNetworkIntercept() {
  console.log('\n--- Trying network intercept on Google Maps ---');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const collectedUrls = new Set();

  // Intercept image requests
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('googleusercontent.com') && response.status() === 200) {
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('image')) {
        // Get the base URL and upgrade to high res
        const baseUrl = url.replace(/=.*$/, '=w1200-h800-k-no');
        collectedUrls.add(baseUrl);
      }
    }
  });

  try {
    await page.goto('https://www.google.com/maps/search/Favorite+Lake+Restaurant+JLT+Dubai', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await delay(4000);

    // Accept cookies
    try {
      const acceptBtn = await page.$('button[aria-label="Accept all"]');
      if (acceptBtn) await acceptBtn.click();
      await delay(1000);
    } catch (e) {}

    // Click on the first result
    try {
      await page.waitForSelector('[role="feed"] > div', { timeout: 10000 });
      const firstResult = await page.$('[role="feed"] > div:first-child');
      if (firstResult) {
        await firstResult.click();
        await delay(4000);
      }
    } catch (e) {}

    // Try to click photos
    const photoSelectors = [
      'button[aria-label*="photo"]',
      'button[aria-label*="Photo"]',
      'img[decoding="async"][src*="googleusercontent"]',
    ];
    for (const sel of photoSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await delay(4000);
          break;
        }
      } catch (e) {}
    }

    // Scroll through photos
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => {
        const scrollable = document.querySelector('[role="main"]') || document.querySelector('.section-scrollbox');
        if (scrollable) scrollable.scrollTop += 1000;
        else window.scrollBy(0, 1000);
      });
      await delay(600);
    }

    console.log(`Network intercept captured ${collectedUrls.size} image URLs`);

    const urls = Array.from(collectedUrls);
    let count = 0;
    for (const url of urls) {
      count++;
      const filename = `net_photo_${count}.jpg`;
      const filepath = path.join(OUTPUT_DIR, filename);
      try {
        await downloadImage(url, filepath);
        console.log(`Downloaded: ${filename}`);
      } catch (e) {
        console.log(`Failed: ${filename}: ${e.message}`);
      }
    }
  } catch (error) {
    console.error('Error in network intercept:', error.message);
  } finally {
    await browser.close();
  }
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  await scrapeGoogleMapsPhotos();
  await scrapeViaNetworkIntercept();
  await scrapeFromGoogleImages();
  await scrapeFromZomato();
  await scrapeFrom2GIS();

  // List and check downloaded files - remove any that are too small (likely errors)
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => !f.startsWith('_'));
  let validCount = 0;
  for (const f of files) {
    const filepath = path.join(OUTPUT_DIR, f);
    const stats = fs.statSync(filepath);
    if (stats.size < 5000) {
      console.log(`Removing too-small file: ${f} (${stats.size} bytes)`);
      fs.unlinkSync(filepath);
    } else {
      validCount++;
      console.log(`  ✓ ${f} (${(stats.size / 1024).toFixed(1)} KB)`);
    }
  }
  console.log(`\n✅ Total valid images downloaded: ${validCount}`);
}

main().catch(console.error);
