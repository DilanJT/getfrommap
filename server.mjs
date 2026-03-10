import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { resolveShortUrl, scrapeGoogleMapsPhotos } from './scrape-restaurant.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const JOBS = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Start a scrape job
app.post('/api/scrape', (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('google') && !url.includes('goo.gl') && !url.includes('maps'))) {
    return res.status(400).json({ error: 'Please provide a valid Google Maps URL' });
  }

  // Only allow one scrape at a time (Puppeteer is heavy)
  const running = Array.from(JOBS.values()).find(j => j.status === 'running');
  if (running) {
    return res.status(429).json({ error: 'A scrape is already in progress. Please wait.' });
  }

  const jobId = crypto.randomBytes(6).toString('hex');
  // Temp dir for scraper debug screenshots only
  const outputDir = path.join(__dirname, 'tmp', jobId);
  fs.mkdirSync(outputDir, { recursive: true });

  JOBS.set(jobId, { status: 'running', progress: [], imageUrls: [], sseClients: [] });
  res.json({ jobId });

  runScrapeJob(jobId, url, outputDir);
});

async function runScrapeJob(jobId, url, outputDir) {
  const job = JOBS.get(jobId);

  const emit = (data) => {
    job.progress.push(data);
    for (const client of job.sseClients) {
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  try {
    // Resolve short URL
    let resolvedUrl = url;
    if (url.includes('goo.gl')) {
      emit({ stage: 'resolving', message: 'Resolving short URL...' });
      resolvedUrl = await resolveShortUrl(url);
      emit({ stage: 'resolving', message: 'URL resolved' });
    }

    // Scrape photos (onProgress callback streams SSE events)
    const urls = await scrapeGoogleMapsPhotos(resolvedUrl, outputDir, (progress) => {
      emit(progress);
    });

    // Store URLs in memory — no disk downloads
    job.imageUrls = urls;
    job.status = 'done';
    emit({
      stage: 'complete',
      message: `Done! ${urls.length} photos found.`,
      images: urls.map((_, i) => ({ index: i, filename: `photo_${i + 1}.jpg` })),
      total: urls.length,
    });

  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    emit({ stage: 'error', message: err.message });
  }

  // Clean up temp debug dir
  try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) {}

  // Close all SSE connections
  for (const client of job.sseClients) {
    client.end();
  }
  job.sseClients = [];
}

// SSE progress stream
app.get('/api/scrape/:jobId/progress', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Replay past events
  for (const event of job.progress) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (job.status === 'done' || job.status === 'error') {
    res.end();
    return;
  }

  job.sseClients.push(res);
  req.on('close', () => {
    job.sseClients = job.sseClients.filter(c => c !== res);
  });
});

// Proxy a single image (streams from Google CDN without saving to disk)
app.get('/api/scrape/:jobId/image/:index', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const index = parseInt(req.params.index, 10);
  if (isNaN(index) || index < 0 || index >= job.imageUrls.length) {
    return res.status(404).json({ error: 'Image not found' });
  }

  const imageUrl = job.imageUrls[index];
  const proto = imageUrl.startsWith('https') ? https : http;

  const proxyReq = proto.get(imageUrl, (proxyRes) => {
    if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302) {
      const redirectUrl = proxyRes.headers.location;
      const rProto = redirectUrl.startsWith('https') ? https : http;
      rProto.get(redirectUrl, (rRes) => {
        res.set('Content-Type', rRes.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        rRes.pipe(res);
      }).on('error', () => res.status(502).end());
      return;
    }
    res.set('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => res.status(502).json({ error: 'Failed to fetch image' }));
});

// Download a single image (with Content-Disposition for browser download)
app.get('/api/scrape/:jobId/download/:index', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const index = parseInt(req.params.index, 10);
  if (isNaN(index) || index < 0 || index >= job.imageUrls.length) {
    return res.status(404).json({ error: 'Image not found' });
  }

  const filename = `photo_${index + 1}.jpg`;
  const imageUrl = job.imageUrls[index];
  const proto = imageUrl.startsWith('https') ? https : http;

  const proxyReq = proto.get(imageUrl, (proxyRes) => {
    if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302) {
      const redirectUrl = proxyRes.headers.location;
      const rProto = redirectUrl.startsWith('https') ? https : http;
      rProto.get(redirectUrl, (rRes) => {
        res.set('Content-Type', 'image/jpeg');
        res.set('Content-Disposition', `attachment; filename="${filename}"`);
        rRes.pipe(res);
      }).on('error', () => res.status(502).end());
      return;
    }
    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => res.status(502).json({ error: 'Failed to fetch image' }));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
