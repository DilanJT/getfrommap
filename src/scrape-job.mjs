import { resolveShortUrl, scrapeGoogleMapsPhotos } from './scraper.mjs';

/**
 * Durable Object that manages a single scrape job's lifecycle.
 * Holds progress events, image URLs, and streams SSE to connected clients.
 */
export class ScrapeJob {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.status = 'idle'; // idle | running | done | error
    this.progress = [];
    this.imageUrls = [];
    this.errorMessage = null;
    this.sseControllers = []; // WritableStreamDefaultController[]
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/start') {
      return this.handleStart(request);
    }
    if (request.method === 'GET' && path === '/progress') {
      return this.handleProgress();
    }
    if (request.method === 'GET' && path.startsWith('/image/')) {
      const index = parseInt(path.split('/image/')[1], 10);
      return this.handleImage(index, false);
    }
    if (request.method === 'GET' && path.startsWith('/download/')) {
      const index = parseInt(path.split('/download/')[1], 10);
      return this.handleImage(index, true);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleStart(request) {
    if (this.status === 'running') {
      return Response.json({ error: 'A scrape is already in progress.' }, { status: 429 });
    }

    const { url } = await request.json();

    this.status = 'running';
    this.progress = [];
    this.imageUrls = [];
    this.errorMessage = null;

    // Run scrape in background (don't await — let it stream progress via SSE)
    this.runScrape(url);

    return Response.json({ ok: true });
  }

  async runScrape(url) {
    const emit = (data) => {
      this.progress.push(data);
      const encoded = new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
      for (const controller of this.sseControllers) {
        try {
          controller.enqueue(encoded);
        } catch (e) {
          // Client disconnected
        }
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

      // Scrape photos
      const urls = await scrapeGoogleMapsPhotos(this.env.MYBROWSER, resolvedUrl, (progress) => {
        emit(progress);
      });

      this.imageUrls = urls;
      this.status = 'done';
      emit({
        stage: 'complete',
        message: `Done! ${urls.length} photos found.`,
        images: urls.map((_, i) => ({ index: i, filename: `photo_${i + 1}.jpg` })),
        total: urls.length,
      });
    } catch (err) {
      this.status = 'error';
      this.errorMessage = err.message;
      emit({ stage: 'error', message: err.message });
    }

    // Close all SSE streams
    for (const controller of this.sseControllers) {
      try {
        controller.close();
      } catch (e) {}
    }
    this.sseControllers = [];
  }

  handleProgress() {
    const encoder = new TextEncoder();
    let controllerRef;

    const stream = new ReadableStream({
      start: (controller) => {
        controllerRef = controller;

        // Replay past events
        for (const event of this.progress) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }

        // If job is already finished, close immediately
        if (this.status === 'done' || this.status === 'error') {
          controller.close();
          return;
        }

        // Otherwise, register for future events
        this.sseControllers.push(controller);
      },
      cancel: () => {
        this.sseControllers = this.sseControllers.filter(c => c !== controllerRef);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  async handleImage(index, asDownload) {
    if (isNaN(index) || index < 0 || index >= this.imageUrls.length) {
      return Response.json({ error: 'Image not found' }, { status: 404 });
    }

    const imageUrl = this.imageUrls[index];

    try {
      const resp = await fetch(imageUrl);
      const headers = new Headers({
        'Content-Type': resp.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      });

      if (asDownload) {
        headers.set('Content-Disposition', `attachment; filename="photo_${index + 1}.jpg"`);
      }

      return new Response(resp.body, { headers });
    } catch (e) {
      return Response.json({ error: 'Failed to fetch image' }, { status: 502 });
    }
  }
}
