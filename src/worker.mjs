export { ScrapeJob } from './scrape-job.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /api/scrape — start a new scrape job
    if (request.method === 'POST' && path === '/api/scrape') {
      const body = await request.json();
      const inputUrl = body.url;

      if (
        !inputUrl ||
        (!inputUrl.includes('google') && !inputUrl.includes('goo.gl') && !inputUrl.includes('maps'))
      ) {
        return Response.json({ error: 'Please provide a valid Google Maps URL' }, { status: 400 });
      }

      // Create a unique Durable Object per job
      const jobId = crypto.randomUUID().slice(0, 12);
      const doId = env.SCRAPE_JOB.idFromName(jobId);
      const stub = env.SCRAPE_JOB.get(doId);

      // Tell the DO to start scraping
      const doResp = await stub.fetch(new Request('https://do/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: inputUrl }),
      }));

      const doResult = await doResp.json();
      if (doResult.error) {
        return Response.json({ error: doResult.error }, { status: 429 });
      }

      return Response.json({ jobId });
    }

    // Routes that target a specific job: /api/scrape/:jobId/...
    const jobMatch = path.match(/^\/api\/scrape\/([^/]+)\/(progress|image|download)(?:\/(\d+))?$/);
    if (jobMatch) {
      const [, jobId, action, indexStr] = jobMatch;
      const doId = env.SCRAPE_JOB.idFromName(jobId);
      const stub = env.SCRAPE_JOB.get(doId);

      if (action === 'progress') {
        return stub.fetch(new Request('https://do/progress'));
      }

      if (action === 'image' && indexStr !== undefined) {
        return stub.fetch(new Request(`https://do/image/${indexStr}`));
      }

      if (action === 'download' && indexStr !== undefined) {
        return stub.fetch(new Request(`https://do/download/${indexStr}`));
      }
    }

    // Everything else falls through to static assets (public/)
    return env.ASSETS.fetch(request);
  },
};
