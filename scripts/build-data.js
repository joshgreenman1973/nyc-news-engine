#!/usr/bin/env node
// ─── Static build script for GitHub Actions ───────────────────────────
// Runs the same curation logic as server.js, but writes JSON files
// to public/data/ instead of serving over HTTP.
//
// Outputs:
//   public/data/curated.json  — current Today's Picks, sidebar sections, etc.
//   public/data/feeds.json    — raw per-outlet feed data (for By Outlet view)
//   public/data/archive.json  — rolling 6-month archive of scored stories
//   public/data/meta.json     — last-updated timestamp, outlet list

process.env.NO_DB = '1';

const fs = require('fs');
const path = require('path');
const { fetchAllFeeds, OUTLETS } = require('../server.js');

const DATA_DIR = path.join(__dirname, '..', 'public', 'data');
const ARCHIVE_PATH = path.join(DATA_DIR, 'archive.json');
const CURATED_PATH = path.join(DATA_DIR, 'curated.json');
const FEEDS_PATH = path.join(DATA_DIR, 'feeds.json');
const META_PATH = path.join(DATA_DIR, 'meta.json');

const ARCHIVE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000; // 6 months

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('Fetching all feeds...');
  const { feeds, curated } = await fetchAllFeeds();
  const now = new Date();
  const lastUpdated = now.toISOString();

  // Collect all scored stories for the archive.
  // `curated.latest` already has 80 most recent; we want everything scored.
  const allScored = new Map();
  for (const slug of Object.keys(feeds)) {
    const feed = feeds[slug];
    if (!feed || !feed.items) continue;
    for (const item of feed.items) {
      if (!item.id || !item.link || !item.title) continue;
      // Strip categories blob from archive to keep size down
      const { categories, ...slim } = item;
      allScored.set(item.id, slim);
    }
  }

  // Merge into existing archive (load, dedupe by id, trim to retention window)
  let archive = [];
  try {
    const existing = fs.readFileSync(ARCHIVE_PATH, 'utf8');
    archive = JSON.parse(existing);
    if (!Array.isArray(archive)) archive = [];
  } catch {
    archive = [];
  }

  // Build new archive: combine existing + new, dedup by id, keep newest within retention
  const byId = new Map();
  for (const s of archive) {
    if (s && s.id) byId.set(s.id, s);
  }
  for (const [id, s] of allScored) {
    byId.set(id, s); // new scored version wins (in case score/rank changed)
  }

  const cutoff = now.getTime() - ARCHIVE_RETENTION_MS;
  const mergedArchive = Array.from(byId.values())
    .filter(s => {
      if (!s.pubDate) return true; // keep items without a date
      const t = new Date(s.pubDate).getTime();
      return Number.isFinite(t) ? t >= cutoff : true;
    })
    .sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });

  // Write outputs
  fs.writeFileSync(
    CURATED_PATH,
    JSON.stringify({ curated, lastUpdated }),
  );

  fs.writeFileSync(
    FEEDS_PATH,
    JSON.stringify({ feeds, outlets: OUTLETS, lastUpdated }),
  );

  fs.writeFileSync(
    ARCHIVE_PATH,
    JSON.stringify(mergedArchive),
  );

  fs.writeFileSync(
    META_PATH,
    JSON.stringify({
      lastUpdated,
      outlets: OUTLETS,
      totalScored: curated.totalScored,
      archiveCount: mergedArchive.length,
    }),
  );

  console.log(`✓ Wrote curated.json (${curated.essential.length} essential + ${curated.notable.length} notable + ${curated.standard.length} standard)`);
  console.log(`✓ Wrote feeds.json (${Object.keys(feeds).length} outlets)`);
  console.log(`✓ Wrote archive.json (${mergedArchive.length} stories, 6-month rolling)`);
  console.log(`✓ Wrote meta.json`);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
