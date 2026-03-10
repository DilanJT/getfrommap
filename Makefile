.PHONY: install serve scrape-favorite scrape-askim scrape dev\:worker deploy clean

install:
	npm install

serve:
	node server.mjs

# Scrape photos for Favorite Lake Restaurant (original)
scrape-favorite:
	node scrape-photos.mjs
	node scrape-more.mjs

# Scrape photos for Askim Restaurant
scrape-askim:
	node scrape-restaurant.mjs "https://maps.app.goo.gl/9mUhGXLy2kwNGpDKA" ./public/images/askim

# Scrape any Google Maps location: make scrape URL="<google-maps-url>" OUT="./public/images/output"
scrape:
	@if [ -z "$(URL)" ]; then echo "Usage: make scrape URL=\"<google-maps-url>\" OUT=\"./output-dir\""; exit 1; fi
	node scrape-restaurant.mjs "$(URL)" $(or $(OUT),./public/images/output)

dev:
	npx wrangler dev

deploy:
	npx wrangler deploy

clean:
	rm -rf public/images/*/_debug_*.png
