# NYC News Engine

https://nycnewsengine.com/ — New York City public policy journalism from more than 40 newsrooms, scored for depth of reporting and policy relevance.

## How it runs

- `server.js` holds the outlet list and all curation logic (feeds, topic tags, scoring, Today's Picks, sidebars).
- `scripts/build-data.js` runs that logic once and writes static JSON to `public/data/`: `curated.json`, `feeds.json`, `archive.json` (six months) and `meta.json` (timestamp plus a per-outlet `feedHealth` list).
- `.github/workflows/build-and-deploy.yml` builds and deploys to GitHub Pages, then starts its own next run 15 minutes later. `.github/workflows/keepalive.yml` checks hourly that the chain is running, restarts it if not, and fails (GitHub emails the repo owner) when the live data is more than three hours old.
- `public/index.html` is the whole front end.

## Why it doesn't use a plain cron

The site froze from Sept. 22 to Oct. 9, 2026. GitHub switches off cron workflows in a public repo after 60 days without a commit, and the last commit was July 24. From Oct. 1 GitHub's scheduler was also starting only a few runs a day of frequent cron workflows. The self-starting chain avoids both. The workflow comments have the details.

## Pausing updates

Disable "Build and deploy to GitHub Pages" in the repo's Actions tab. The backstop leaves a workflow alone when it was disabled by hand. Enable it again and run it once to restart.

## The archive

`archive.json` rides between runs in the Actions cache. GitHub evicts caches unused for seven days, so after any pause the build recovers the archive from the live site (`https://nycnewsengine.com/data/archive.json`) instead of starting over. If neither copy can be read, the build refuses to publish.

## Feeds that need workarounds

- **Vital City** answers GitHub's runners with a bot check, so the build reads the Ghost Content API on `vital-city.ghost.io` (public read-only key) and falls back to `/archive/rss/`.
- **Substack** newsletters on `*.substack.com` return 403 to every GitHub runner. Each has a Google News `site:` search as a fallback, limited to the past 30 days. Google News indexes Substack thinly, so these are often empty in production. Newsletters on their own domains (Maximum New York, Sidewalk Chorus, Political Currents, The Bigger Apple) are not blocked.
- **Brooklyn Eagle** returns 403 to the runners; its fallback is Google News.
- **NY1, CBS News New York, WNYC and the Wall Street Journal** have no usable RSS and come from Google News searches, which carry no snippets or bylines, so their stories rarely clear the Today's Picks substance gate.
- **Gotham Gazette**'s feed has returned 500 since at least August 2026.
- **Reddit** usually refuses requests from the runners, so "Buzzing in NYC" is mostly Google News.

## Local preview

```bash
NO_DB=1 node scripts/build-data.js
python3 -m http.server 8846 --directory public
```

The build takes about a minute and hits every feed. `npm start` runs the older Express server with a SQLite archive instead.
