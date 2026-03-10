# Google Maps Photo Scraper

Scrapes high-resolution photos from any Google Maps location using Puppeteer. Works with restaurants, hotels, parks, landmarks, shops — anything with a Google Maps listing.

## Setup

```bash
make install
```

## Usage

### Scrape any Google Maps location

```bash
make scrape URL="https://maps.app.goo.gl/YOUR_LINK" OUT="./public/images/place-name"
```

Or directly:

```bash
node scrape-restaurant.mjs "https://maps.app.goo.gl/YOUR_LINK" ./public/images/place-name
```

### Pre-configured targets

```bash
make scrape-favorite   # Favorite Lake Restaurant (JLT, Dubai)
make scrape-askim      # Askim Restaurant and Cafe (Dubai)
```

### Clean debug screenshots

```bash
make clean
```

## How it works

1. Resolves short `maps.app.goo.gl` URLs to full Google Maps place URLs
2. Opens the location listing in headless Chrome via Puppeteer
3. Enters the photo gallery and scrolls to load thumbnails
4. Intercepts network responses to capture `googleusercontent.com` image URLs
5. Navigates through photos via clicking and arrow keys to trigger more loads
6. Downloads all unique images at 1200x800 resolution
7. Removes files under 5KB (error pages / broken downloads)

## Output

- `photo_1.jpg`, `photo_2.jpg`, ... — downloaded images
- `_photo_urls.json` — list of all extracted image URLs
- `_debug_*.png` — screenshots captured during scraping (for troubleshooting)
