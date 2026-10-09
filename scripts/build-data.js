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
const { fetchAllFeeds, OUTLETS, isNycRelevant } = require('../server.js');

const DATA_DIR = path.join(__dirname, '..', 'public', 'data');
const ARCHIVE_PATH = path.join(DATA_DIR, 'archive.json');
const CURATED_PATH = path.join(DATA_DIR, 'curated.json');
const FEEDS_PATH = path.join(DATA_DIR, 'feeds.json');
const META_PATH = path.join(DATA_DIR, 'meta.json');

const ARCHIVE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000; // 6 months
const LIVE_ARCHIVE_URL = 'https://nycnewsengine.com/data/archive.json';
const EL_DIARIO_FILTER_START = new Date('2026-10-09T00:00:00-04:00');

// Fields the Archive view uses. Scoring internals (score, rank, flags) are
// dropped to keep the download small; they only matter for the live views.
const ARCHIVE_FIELDS = ['id', 'title', 'link', 'pubDate', 'snippet', 'author', 'topics', 'outlet', 'outletSlug', 'outletColor'];

// Load the archive the last run left behind. The Actions cache normally
// restores it, but GitHub evicts caches unused for 7 days, so after any
// pause the cache comes back empty. The deployed copy on the live site is
// the durable one: fall back to it rather than start over and publish an
// archive with six months missing.
async function loadPreviousArchive() {
  try {
    const local = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));
    if (Array.isArray(local) && local.length > 0) {
      console.log(`Archive: ${local.length} stories from the previous run's cache`);
      return local;
    }
  } catch {}
  try {
    const res = await fetch(LIVE_ARCHIVE_URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const live = await res.json();
    if (!Array.isArray(live)) throw new Error('not an array');
    console.log(`Archive: no cached copy; recovered ${live.length} stories from ${LIVE_ARCHIVE_URL}`);
    return live;
  } catch (err) {
    // Starting over would overwrite the live archive with a near-empty one.
    throw new Error(`No cached archive and the live one could not be read (${err.message}). Not publishing.`);
  }
}

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
  const archive = await loadPreviousArchive();

  // Build new archive: combine existing + new, dedup by id, keep newest within retention
  const byId = new Map();
  for (const s of archive) {
    if (!s || !s.id) continue;
    // El Diario joined the NYC-relevance filter on Oct. 9, 2026. Before that
    // its national, Latin American, sports and celebrity stories made up a
    // third of the archive; clear that backlog too. Only older stories: newer
    // ones already passed the filter with their RSS categories, which the
    // archive doesn't keep. (Dead code once the backlog ages out in April 2027.)
    if (s.outletSlug === 'el-diario' && new Date(s.pubDate || 0) < EL_DIARIO_FILTER_START
        && !isNycRelevant(s)) continue;
    byId.set(s.id, s);
  }
  for (const [id, s] of allScored) {
    byId.set(id, s); // new scored version wins (in case score/rank changed)
  }

  const cutoff = now.getTime() - ARCHIVE_RETENTION_MS;
  // Truncate snippets in the archive to keep the file size manageable —
  // archive search matches on titles + snippet leads, so this preserves
  // most search utility at a fraction of the payload.
  const ARCHIVE_SNIPPET_LEN = 180;
  const mergedArchive = Array.from(byId.values())
    .filter(s => {
      if (!s.pubDate) return true; // keep items without a date
      const t = new Date(s.pubDate).getTime();
      return Number.isFinite(t) ? t >= cutoff : true;
    })
    .map(s => {
      const slim = {};
      for (const k of ARCHIVE_FIELDS) if (s[k] != null) slim[k] = s[k];
      if (slim.snippet && slim.snippet.length > ARCHIVE_SNIPPET_LEN) {
        slim.snippet = slim.snippet.slice(0, ARCHIVE_SNIPPET_LEN).trimEnd() + '…';
      }
      return slim;
    })
    .sort((a, b) => {
      const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return tb - ta;
    });

  // A systemic outage (network down, DNS, a bad deploy) and a genuinely quiet
  // news hour both end here with nothing to show. The difference is that one of
  // them must not stamp a fresh "updated just now" over empty picks and exit
  // clean — that reads as healthy forever while the site rots.
  const feedList = Object.values(feeds).filter(Boolean);
  const outletsWithItems = feedList.filter(f => f.items && f.items.length > 0).length;
  const outletsErrored = feedList.filter(f => f.error).length;

  if (curated.totalScored === 0 || outletsWithItems === 0) {
    console.error(
      `Refusing to publish: ${curated.totalScored} stories scored across ` +
      `${outletsWithItems}/${feedList.length} outlets (${outletsErrored} errored). ` +
      `Treating this as a broken fetch, not a quiet news day. Existing data left in place.`,
    );
    process.exit(1);
  }

  // Some outlets always fail (paywalls, flaky feeds) — 6 of 43 is normal. Most
  // of them failing at once is infrastructure, not journalism.
  if (outletsErrored > feedList.length / 2) {
    console.error(
      `Refusing to publish: ${outletsErrored}/${feedList.length} outlets errored. ` +
      `That's a systemic failure, not scattered feed trouble.`,
    );
    process.exit(1);
  }

  if (outletsErrored > 0) {
    console.warn(`Note: ${outletsErrored}/${feedList.length} outlets errored this run.`);
  }

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
      // Per-outlet result of this run, for spotting feeds that have gone dark
      feedHealth: feedList.map(f => ({
        slug: f.outlet.slug,
        items: (f.items || []).length,
        via: f.via || null,
        error: f.error || null,
      })),
    }),
  );

  console.log(`✓ Wrote curated.json (${curated.essential.length} essential + ${curated.notable.length} notable + ${curated.standard.length} standard)`);
  console.log(`✓ Wrote feeds.json (${Object.keys(feeds).length} outlets)`);
  console.log(`✓ Wrote archive.json (${mergedArchive.length} stories, 6-month rolling)`);
  console.log(`✓ Wrote meta.json`);
}

main().then(() => {
  // All outputs are written synchronously above. Exit explicitly so a
  // straggling feed socket can't keep the process alive — without this,
  // a hung RSS server stalls the GitHub Action until its 10-min timeout.
  process.exit(0);
}).catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
