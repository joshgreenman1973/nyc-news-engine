const express = require('express');
const Parser = require('rss-parser');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'NYC-News-Engine/1.0 (local news aggregator)',
    Accept: 'application/rss+xml, application/xml, text/xml',
  },
});

// ─── Database setup ───────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'archive.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    pub_date TEXT,
    snippet TEXT,
    author TEXT,
    outlet_name TEXT,
    outlet_slug TEXT,
    outlet_tier INTEGER,
    outlet_color TEXT,
    score INTEGER DEFAULT 0,
    rank TEXT,
    topics TEXT,
    categories TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    UNIQUE(link)
  );
  CREATE INDEX IF NOT EXISTS idx_stories_date ON stories(pub_date DESC);
  CREATE INDEX IF NOT EXISTS idx_stories_outlet ON stories(outlet_slug);
  CREATE INDEX IF NOT EXISTS idx_stories_score ON stories(score DESC);
  CREATE INDEX IF NOT EXISTS idx_stories_topics ON stories(topics);
`);

// Purge stories older than 6 months
const purgeStmt = db.prepare(`DELETE FROM stories WHERE pub_date < datetime('now', '-6 months')`);
const upsertStmt = db.prepare(`
  INSERT INTO stories (id, title, link, pub_date, snippet, author, outlet_name, outlet_slug, outlet_tier, outlet_color, score, rank, topics, categories)
  VALUES (@id, @title, @link, @pubDate, @snippet, @author, @outletName, @outletSlug, @outletTier, @outletColor, @score, @rank, @topics, @categories)
  ON CONFLICT(link) DO UPDATE SET
    score = @score, rank = @rank, topics = @topics, fetched_at = datetime('now')
`);

// ─── Outlet definitions ───────────────────────────────────────────────
const OUTLETS = [
  { name: 'THE CITY', slug: 'the-city', tier: 1, url: 'https://www.thecity.nyc/feed/', site: 'https://www.thecity.nyc', color: '#1a5632', tagline: 'Nonprofit investigative newsroom' },
  { name: 'Vital City', slug: 'vital-city', tier: 1, url: 'https://www.vitalcitynyc.org/commentary/rss/', site: 'https://www.vitalcitynyc.org', color: '#e63b2e', tagline: 'Urban policy & ideas' },
  { name: 'Hell Gate', slug: 'hell-gate', tier: 1, url: 'https://hellgatenyc.com/all-posts/rss/', site: 'https://hellgatenyc.com', color: '#ff4500', tagline: 'Worker-owned NYC journalism' },
  { name: 'Gothamist', slug: 'gothamist', tier: 1, url: 'https://gothamist.com/feed', site: 'https://gothamist.com', color: '#de2d26', tagline: 'WNYC-backed local news' },
  { name: 'New York Focus', slug: 'ny-focus', tier: 1, url: 'https://nysfocus.com/feed', site: 'https://nysfocus.com', color: '#2c5282', tagline: 'State politics & accountability' },
  { name: 'Documented', slug: 'documented', tier: 1, url: 'https://documentedny.com/feed/', site: 'https://documentedny.com', color: '#2b6cb0', tagline: 'Immigration in New York' },
  { name: 'Chalkbeat NYC', slug: 'chalkbeat', tier: 1, url: 'https://www.chalkbeat.org/arc/outboundfeeds/rss/category/new-york/', site: 'https://www.chalkbeat.org/newyork/', color: '#6b46c1', tagline: 'Education reporting' },
  { name: 'City Limits', slug: 'city-limits', tier: 1, url: 'https://citylimits.org/feed/', site: 'https://citylimits.org', color: '#d97706', tagline: 'Nonprofit policy journalism since 1976' },
  { name: 'Streetsblog NYC', slug: 'streetsblog', tier: 1, url: 'https://nyc.streetsblog.org/feed', site: 'https://nyc.streetsblog.org', color: '#059669', tagline: 'Transit & street safety policy' },
  { name: 'Bolts', slug: 'bolts', tier: 1, url: 'https://boltsmag.org/feed/', site: 'https://boltsmag.org', color: '#7c3aed', tagline: 'Criminal justice & local democracy' },
  { name: 'The Trace', slug: 'the-trace', tier: 1, url: 'https://thetrace.org/feed/', site: 'https://thetrace.org', color: '#b91c1c', tagline: 'Gun violence reporting' },
  { name: 'The Markup', slug: 'the-markup', tier: 1, url: 'https://themarkup.org/feeds/rss.xml', site: 'https://themarkup.org', color: '#374151', tagline: 'Tech & algorithmic accountability' },
  { name: 'The Marshall Project', slug: 'marshall-project', tier: 1, url: null, site: 'https://www.themarshallproject.org', color: '#92400e', tagline: 'Criminal justice journalism' },
  { name: 'New York Magazine', slug: 'nymag', tier: 1, url: 'https://feeds.feedburner.com/nymag/intelligencer', site: 'https://nymag.com/intelligencer', color: '#e11d48', tagline: 'City life, politics & culture' },
  { name: 'The New Yorker', slug: 'new-yorker', tier: 1, url: 'https://www.newyorker.com/feed/news', site: 'https://www.newyorker.com', color: '#1a1a1a', tagline: 'Longform & essays' },
  // Tier 2 — Major local papers & metro coverage
  { name: 'Daily News', slug: 'daily-news', tier: 2, url: null, site: 'https://www.nydailynews.com', color: '#c53030', tagline: "New York's hometown paper" },
  { name: 'NY Post', slug: 'ny-post', tier: 2, url: 'https://nypost.com/feed/', site: 'https://www.nypost.com', color: '#1a202c', tagline: 'Tabloid with reach' },
  { name: 'NY Times - NYC', slug: 'nytimes', tier: 2, url: 'https://rss.nytimes.com/services/xml/rss/nyt/NYRegion.xml', site: 'https://www.nytimes.com/section/nyregion', color: '#1a1a1a', tagline: 'Metro section' },
  { name: 'ProPublica', slug: 'propublica', tier: 2, url: 'https://www.propublica.org/feeds/propublica/main', site: 'https://www.propublica.org', color: '#1a1a1a', tagline: 'Nonprofit investigations' },
  { name: 'NY Amsterdam News', slug: 'amsterdam-news', tier: 2, url: 'https://amsterdamnews.com/feed/', site: 'https://amsterdamnews.com', color: '#b45309', tagline: "NYC's leading Black newspaper since 1909" },
  { name: 'El Diario', slug: 'el-diario', tier: 2, url: 'https://eldiariony.com/feed/', site: 'https://eldiariony.com', color: '#dc2626', tagline: 'Spanish-language NYC news' },
  { name: 'WNYC', slug: 'wnyc', tier: 2, url: 'https://www.wnyc.org/feeds/all/', site: 'https://www.wnyc.org', color: '#1e40af', tagline: 'Public radio news' },
  { name: 'amNewYork', slug: 'amny', tier: 2, url: 'https://www.amny.com/feed/', site: 'https://www.amny.com', color: '#0369a1', tagline: 'Metro daily' },
  // Tier 3 — Broadcast & hyperlocal
  { name: 'NY1', slug: 'ny1', tier: 3, url: null, site: 'https://ny1.com', color: '#2d3748', tagline: 'Cable news for the city' },
  { name: 'ABC7 NY', slug: 'abc7', tier: 3, url: 'https://abc7ny.com/feed/', site: 'https://abc7ny.com', color: '#2b6cb0', tagline: 'Local TV news' },
  { name: 'CBS News NY', slug: 'cbsny', tier: 3, url: null, site: 'https://www.cbsnews.com/newyork/', color: '#1a365d', tagline: 'Local TV news' },
  { name: 'Brooklyn Eagle', slug: 'brooklyn-eagle', tier: 3, url: 'https://brooklyneagle.com/feed/', site: 'https://brooklyneagle.com', color: '#4338ca', tagline: 'Brooklyn borough news' },
  // Tier 2 — National with NYC filter
  { name: 'Wall Street Journal', slug: 'wsj', tier: 2, url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', site: 'https://www.wsj.com', color: '#0a0a0a', tagline: 'Business & policy' },
  // Tier 1 — Substack / Interview series
  { name: 'NY Editorial Board', slug: 'ny-editorial-board', tier: 1, url: 'https://nyeditorialboard.substack.com/feed', site: 'https://nyeditorialboard.substack.com', color: '#b45309', tagline: 'NYC interviews & commentary' },
];

// ─── Topic classification ─────────────────────────────────────────────
const TOPIC_RULES = [
  { topic: 'Housing', keywords: ['housing', 'rent', 'tenant', 'landlord', 'eviction', 'affordable housing', 'NYCHA', 'public housing', 'shelter', 'zoning', 'rezoning', 'real estate', 'apartment', 'lease', 'homeless', 'unhoused', 'voucher'] },
  { topic: 'Education', keywords: ['school', 'education', 'student', 'teacher', 'DOE', 'charter', 'college', 'university', 'CUNY', 'SUNY', 'pre-k', 'curriculum', 'chancellor', 'class size', 'graduation'] },
  { topic: 'Immigration', keywords: ['immigration', 'immigrant', 'migrant', 'asylum', 'ICE', 'deportation', 'sanctuary', 'refugee', 'TPS', 'undocumented', 'border', 'DACA'] },
  { topic: 'Criminal Justice', keywords: ['criminal justice', 'police', 'NYPD', 'prosecution', 'district attorney', 'prison', 'jail', 'Rikers', 'bail', 'sentencing', 'parole', 'probation', 'incarcerat'] },
  { topic: 'Public Safety', keywords: ['crime', 'shooting', 'stabbing', 'assault', 'robbery', 'murder', 'homicide', 'gun violence', 'safety', 'gang'] },
  { topic: 'Transit', keywords: ['transit', 'MTA', 'subway', 'bus', 'commut', 'congestion pricing', 'train', 'rail', 'bike lane', 'cyclist', 'pedestrian', 'traffic', 'transport', 'streetscape', 'speed camera', 'Vision Zero', 'DOT', 'Citibike', 'ferry', 'e-bike', 'scooter', 'crosswalk', 'sidewalk'] },
  { topic: 'Health', keywords: ['health', 'hospital', 'mental health', 'opioid', 'fentanyl', 'overdose', 'COVID', 'pandemic', 'clinic', 'Medicaid', 'insurance', 'public health', 'H+H'] },
  { topic: 'Climate & Environment', keywords: ['climate', 'environment', 'flooding', 'clean energy', 'emissions', 'pollution', 'air quality', 'green', 'sustainability', 'resiliency', 'waste', 'recycling', 'composting'] },
  { topic: 'City Hall', keywords: ['mayor', 'city hall', 'city council', 'Adams', 'municipal', 'city budget', 'commissioner', 'agency', 'administration'] },
  { topic: 'Albany & State', keywords: ['Albany', 'governor', 'Hochul', 'state legislature', 'state senate', 'assembly', 'state budget', 'New York State'] },
  { topic: 'Labor', keywords: ['labor', 'union', 'worker', 'wage', 'strike', 'gig economy', 'minimum wage', 'employment', 'unemployment'] },
  { topic: 'Investigations', keywords: ['investigation', 'investigat', 'exclusive', 'obtained', 'documents show', 'records reveal', 'FOIL', 'FOIA', 'uncovered', 'corruption', 'fraud', 'indicted'] },
  { topic: 'Race & Equity', keywords: ['race', 'racial', 'racism', 'equity', 'discrimination', 'segregation', 'diversity', 'DEI', 'reparations', 'civil rights', 'hate crime', 'bias'] },
  { topic: 'Culture & Community', keywords: ['community', 'neighborhood', 'borough', 'arts', 'culture', 'restaurant', 'local business', 'small business', 'library', 'park'] },
];

function classifyTopics(title, snippet, categories) {
  const combined = `${title} ${snippet} ${(categories || []).join(' ')}`.toLowerCase();
  const matched = [];

  for (const rule of TOPIC_RULES) {
    for (const kw of rule.keywords) {
      if (combined.includes(kw.toLowerCase())) {
        if (!matched.includes(rule.topic)) {
          matched.push(rule.topic);
        }
        break;
      }
    }
  }

  return matched.length > 0 ? matched.slice(0, 3) : ['NYC News'];
}

// ─── Curation scoring ─────────────────────────────────────────────────
const DEPTH_SIGNALS = [
  'investigation', 'investigat', 'exclusive', 'obtained', 'documents show',
  'records reveal', 'data shows', 'data analysis', 'FOIA', 'FOIL',
  'exposed', 'uncovered', 'accountability',
  'analysis', 'explained', 'explainer', 'what you need to know',
  'how it works', 'what it means', 'deep dive', 'in depth',
  'behind the', 'inside the', 'the story behind',
  'policy', 'legislation', 'budget', 'zoning', 'regulation',
  'affordable housing', 'public health', 'criminal justice',
  'education policy', 'transit', 'infrastructure', 'climate',
  'migrant', 'immigration', 'asylum', 'shelter system',
  'mental health', 'homelessness', 'eviction', 'tenant',
  'policing', 'surveillance', 'civil rights', 'civil liberties',
  'public housing', 'NYCHA', 'MTA', 'congestion pricing',
  'months-long', 'year-long', 'series', 'part 1', 'part 2',
  'special report', 'long read', 'feature',
  'first-person', 'oral history', 'profile',
  'community', 'neighborhood', 'borough', 'council',
  'city hall', 'Albany', 'state legislature',
];

const SHALLOW_SIGNALS = [
  'breaking:', 'breaking news', 'just in', 'developing:',
  'update:', 'watch:', 'video:', 'photos:',
  'police say', 'cops say', 'sources say',
  'arrested', 'stabbed', 'shot dead', 'shooting',
  'crash on', 'fire at', 'blaze', 'found dead',
  'weather alert', 'forecast', 'traffic delays',
  'celebrity', 'lottery', 'winning numbers',
  'slideshow', 'gallery', 'ranked', 'top 10',
];

function scoreStory(item, outlet) {
  let score = 0;
  const combined = `${item.title} ${item.snippet || ''}`.toLowerCase();

  if (outlet.tier === 1) score += 15;
  else if (outlet.tier === 2) score += 5;

  for (const s of DEPTH_SIGNALS) {
    if (combined.includes(s.toLowerCase())) score += 8;
  }
  for (const s of SHALLOW_SIGNALS) {
    if (combined.includes(s.toLowerCase())) score -= 12;
  }

  const titleWords = (item.title || '').split(/\s+/).length;
  if (titleWords >= 8 && titleWords <= 20) score += 4;

  const snippetLen = (item.snippet || '').length;
  if (snippetLen > 200) score += 5;
  else if (snippetLen > 100) score += 2;

  if (item.author) score += 3;

  if (item.pubDate) {
    const hoursAgo = (Date.now() - new Date(item.pubDate).getTime()) / 3600000;
    if (hoursAgo < 6) score += 6;
    else if (hoursAgo < 12) score += 4;
    else if (hoursAgo < 24) score += 2;
    else if (hoursAgo > 72) score -= 5;
  }

  return Math.max(0, Math.min(100, score));
}

function classifyRank(score) {
  if (score >= 35) return 'essential';
  if (score >= 20) return 'notable';
  if (score >= 10) return 'standard';
  return 'brief';
}

// ─── Analysis / commentary detection ──────────────────────────────────
// Outlets whose content is almost entirely analysis/commentary
const ANALYSIS_OUTLETS = ['vital-city'];

// Signals in title/snippet/categories that indicate explainer, analysis, op-ed, commentary
const ANALYSIS_SIGNALS = [
  // Explicit labels
  'opinion', 'op-ed', 'oped', 'editorial', 'commentary', 'essay',
  'analysis', 'explainer', 'explained', 'perspective', 'viewpoint',
  'guest essay', 'column', 'the case for', 'the case against',
  'first person', 'first-person', 'letter to',
  // Structural patterns that suggest analysis over news
  'what we know', 'what it means', 'what you need to know',
  'why it matters', 'why this matters', 'here\'s why',
  'how to fix', 'how to think about', 'rethinking',
  'lessons from', 'what we can learn', 'what went wrong',
  'the future of', 'the problem with', 'the myth of',
  'a better way', 'we need to', 'it\'s time to',
  'in defense of', 'against', 'beyond',
  'Q&A', 'interview:', 'conversation with',
  'deep dive', 'long read', 'big picture',
];

// Category tags from RSS that signal opinion/analysis
const ANALYSIS_CATEGORIES = [
  'opinion', 'commentary', 'analysis', 'editorial', 'op-ed',
  'columns', 'essays', 'perspectives', 'ideas', 'viewpoints',
  'explainers', 'policy', 'debate',
];

function isAnalysisStory(item, outlet) {
  // Vital City is almost entirely analysis/commentary
  if (ANALYSIS_OUTLETS.includes(outlet.slug)) return true;

  const titleLower = (item.title || '').toLowerCase();
  const snippetLower = (item.snippet || '').toLowerCase();
  const combined = titleLower + ' ' + snippetLower;
  const categories = (item.categories || []).map((c) =>
    (typeof c === 'string' ? c : String(c)).toLowerCase()
  );

  // Check category tags first (most reliable signal)
  for (const cat of categories) {
    if (ANALYSIS_CATEGORIES.some((ac) => cat.includes(ac))) return true;
  }

  // Check title/snippet signals
  let signalCount = 0;
  for (const signal of ANALYSIS_SIGNALS) {
    if (combined.includes(signal)) signalCount++;
  }

  // Need at least 2 signals from text, or 1 signal + long snippet (suggests depth)
  if (signalCount >= 2) return true;
  if (signalCount >= 1 && (item.snippet || '').length > 200) return true;

  return false;
}

// ─── Feed fetching ────────────────────────────────────────────────────
function cleanSnippet(text) {
  let clean = text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  clean = clean.replace(/\s*\[?\.\.\.\]?\s*The post\s+.+$/i, '');
  clean = clean.replace(/\s*(Continue reading|Read more|Click here).*$/i, '');

  return clean.substring(0, 350);
}

async function fetchFeed(outlet) {
  if (!outlet.url) {
    return { outlet, items: [], error: 'No RSS feed available' };
  }
  try {
    const feed = await parser.parseURL(outlet.url);
    const items = (feed.items || []).slice(0, 20).map((item) => {
      const title = item.title || 'Untitled';
      const link = item.link || '';
      const snippet = cleanSnippet(item.contentSnippet || item.content || '');
      const author = item.creator || item['dc:creator'] || item.author || null;
      const rawCats = item.categories || [];
      const cats = rawCats.map((c) => (typeof c === 'string' ? c : (c._ || c.$ || String(c))));
      const pubDate = item.pubDate || item.isoDate || null;

      const topics = classifyTopics(title, snippet, cats);

      const story = {
        id: crypto.createHash('md5').update(link).digest('hex'),
        title,
        link,
        pubDate,
        snippet: snippet || null,
        author,
        categories: cats,
        topics,
        outlet: outlet.name,
        outletSlug: outlet.slug,
        outletColor: outlet.color,
        outletTier: outlet.tier,
      };

      story.score = scoreStory(story, outlet);
      story.rank = classifyRank(story.score);
      story.isAnalysis = isAnalysisStory(story, outlet);

      return story;
    });

    // For national outlets, filter to NYC-relevant stories only
    const nycOnlyFilter = ['propublica', 'bolts', 'the-trace', 'the-markup', 'nymag', 'new-yorker', 'wsj'];
    let filtered = items;
    if (nycOnlyFilter.includes(outlet.slug)) {
      const NYC_SIGNALS = [
        'new york', 'nyc', 'brooklyn', 'manhattan', 'queens', 'bronx', 'staten island',
        'city council', 'city hall', 'albany', 'cuomo', 'hochul', 'adams',
        'nypd', 'mta', 'rikers', 'nycha', 'de blasio', 'gotham',
      ];
      filtered = items.filter((s) => {
        const text = `${s.title} ${s.snippet || ''} ${(s.categories || []).join(' ')}`.toLowerCase();
        return NYC_SIGNALS.some((sig) => text.includes(sig));
      });
    }

    return { outlet, items: filtered, error: null };
  } catch (err) {
    console.error(`Error fetching ${outlet.name}: ${err.message}`);
    return { outlet, items: [], error: err.message };
  }
}

// ─── Archive helpers ──────────────────────────────────────────────────
function archiveStories(stories) {
  const insert = db.transaction((items) => {
    for (const s of items) {
      upsertStmt.run({
        id: s.id,
        title: s.title,
        link: s.link,
        pubDate: s.pubDate ? new Date(s.pubDate).toISOString() : null,
        snippet: s.snippet,
        author: s.author,
        outletName: s.outlet,
        outletSlug: s.outletSlug,
        outletTier: s.outletTier,
        outletColor: s.outletColor,
        score: s.score,
        rank: s.rank,
        topics: JSON.stringify(s.topics),
        categories: JSON.stringify(s.categories || []),
      });
    }
  });
  insert(stories);
}

// ─── Cache & fetch ────────────────────────────────────────────────────
let feedCache = {};
let curatedCache = null;
let lastFetchTime = null;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchAllFeeds() {
  const now = Date.now();
  if (lastFetchTime && now - lastFetchTime < CACHE_TTL && curatedCache) {
    return { feeds: feedCache, curated: curatedCache };
  }

  console.log(`[${new Date().toLocaleTimeString()}] Refreshing all feeds...`);

  // Purge old archive entries
  purgeStmt.run();

  const results = await Promise.allSettled(OUTLETS.map(fetchFeed));

  const feeds = {};
  const allStories = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { outlet, items, error } = result.value;
      feeds[outlet.slug] = { outlet, items, error };
      allStories.push(...items);
    }
  }

  // Archive to SQLite
  if (allStories.length > 0) {
    archiveStories(allStories);
  }

  // Build curated lists
  const sorted = allStories
    .filter((s) => s.link && s.title !== 'Untitled')
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const deduped = sorted.filter((story) => {
    const key = story.title.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Separate analysis/commentary from news stories
  const analysisPool = deduped.filter((s) => s.isAnalysis && s.score >= 15);
  const newsPool = deduped.filter((s) => !s.isAnalysis);

  // Also grab high-scoring analysis that didn't self-identify but comes from analysis outlets
  const analysis = analysisPool.slice(0, 10);
  const analysisIds = new Set(analysis.map((s) => s.id));

  // Today's Picks: only stories from last 36 hours
  const FRESHNESS_CUTOFF = 36 * 3600 * 1000; // 36 hours in ms
  const nowMs = Date.now();

  const essential = [];
  const notable = [];
  const standard = [];
  const outletCount = {};

  for (const s of newsPool) {
    if (analysisIds.has(s.id)) continue; // skip if already in analysis
    const slug = s.outletSlug;
    outletCount[slug] = (outletCount[slug] || 0);

    // For essential picks, enforce freshness (36h)
    const age = s.pubDate ? nowMs - new Date(s.pubDate).getTime() : Infinity;
    const isFresh = age < FRESHNESS_CUTOFF;

    if (s.rank === 'essential' && essential.length < 10 && isFresh) {
      if (outletCount[slug] < 3) {
        essential.push(s);
        outletCount[slug]++;
      }
    } else if (s.rank === 'notable' && notable.length < 15) {
      notable.push(s);
    } else if (s.rank === 'standard' && standard.length < 20) {
      standard.push(s);
    }
  }

  // "What's Grabbing Headlines" — lead story from major papers & TV
  const headlineOutlets = ['daily-news', 'ny-post', 'nytimes', 'ny1', 'abc7', 'cbsny'];
  const headlines = [];
  for (const slug of headlineOutlets) {
    const feed = feeds[slug];
    if (!feed || feed.error || !feed.items.length) continue;
    // Take the most recent story (already sorted by recency from RSS)
    const lead = feed.items[0];
    if (lead) headlines.push(lead);
  }

  // ─── NYC Podcasts — latest episode from each ───
  const PODCASTS = [
    { name: 'The Brian Lehrer Show', slug: 'brian-lehrer', url: 'https://feeds.simplecast.com/C8a1jmw4', site: 'https://www.wnyc.org/shows/bl', color: '#1e40af' },
    { name: 'FAQ NYC', slug: 'faq-nyc', url: 'https://feeds.fireside.fm/faqnyc/rss', site: 'https://faq.nyc', color: '#1a5632' },
    { name: 'Max Politics', slug: 'max-politics', url: 'https://feeds.soundcloud.com/users/soundcloud:users:205521899/sounds.rss', site: 'https://www.gothamgazette.com/city/6998-max-murphy-on-politics-podcast/', color: '#7c3aed' },
  ];

  const podcasts = [];
  for (const pod of PODCASTS) {
    try {
      const feed = await parser.parseURL(pod.url);
      if (feed.items && feed.items.length > 0) {
        const ep = feed.items[0];
        podcasts.push({
          podcast: pod.name,
          podcastSlug: pod.slug,
          podcastColor: pod.color,
          podcastSite: pod.site,
          title: ep.title || 'Latest Episode',
          link: ep.link || ep.enclosure?.url || pod.site,
          pubDate: ep.pubDate || ep.isoDate || null,
        });
      }
    } catch (e) {
      console.log(`Error fetching podcast ${pod.name}: ${e.message}`);
    }
  }

  // Collect all active topics for the filter UI
  const topicCounts = {};
  for (const s of deduped) {
    for (const t of (s.topics || [])) {
      topicCounts[t] = (topicCounts[t] || 0) + 1;
    }
  }

  // "Latest" view — all stories sorted by pub date descending
  const latest = [...deduped]
    .filter((s) => s.pubDate)
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .slice(0, 80);

  curatedCache = { essential, notable, standard, analysis, headlines, podcasts, latest, totalScored: deduped.length, topicCounts };
  feedCache = feeds;
  lastFetchTime = now;

  console.log(`  Curated: ${essential.length} essential, ${analysis.length} analysis, ${notable.length} notable out of ${deduped.length} stories`);
  return { feeds, curated: curatedCache };
}

// ─── API routes ───────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', stories: curatedCache?.totalScored || 0, lastUpdated: lastFetchTime ? new Date(lastFetchTime).toISOString() : null });
});

app.get('/api/feeds', async (req, res) => {
  try {
    const { feeds, curated } = await fetchAllFeeds();
    res.json({ feeds, curated, lastUpdated: lastFetchTime ? new Date(lastFetchTime).toISOString() : null, outlets: OUTLETS });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feeds' });
  }
});

app.post('/api/refresh', async (req, res) => {
  lastFetchTime = null;
  curatedCache = null;
  const { feeds, curated } = await fetchAllFeeds();
  res.json({ feeds, curated, lastUpdated: new Date(lastFetchTime).toISOString() });
});

// Archive endpoint — paginated, filterable
app.get('/api/archive', (req, res) => {
  const { topic, outlet, page = 1, limit = 50, q } = req.query;
  const pageNum = Math.max(1, parseInt(page));
  const lim = Math.min(100, Math.max(1, parseInt(limit)));
  const offset = (pageNum - 1) * lim;

  let where = '1=1';
  const params = {};

  if (topic) {
    where += ` AND topics LIKE @topic`;
    params.topic = `%"${topic}"%`;
  }
  if (outlet) {
    where += ` AND outlet_slug = @outlet`;
    params.outlet = outlet;
  }
  if (q) {
    where += ` AND (title LIKE @q OR snippet LIKE @q)`;
    params.q = `%${q}%`;
  }

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM stories WHERE ${where}`);
  const { total } = countStmt.get(params);

  const selectStmt = db.prepare(`
    SELECT id, title, link, pub_date, snippet, author, outlet_name, outlet_slug, outlet_tier, outlet_color, score, rank, topics
    FROM stories WHERE ${where}
    ORDER BY pub_date DESC
    LIMIT @limit OFFSET @offset
  `);

  const stories = selectStmt.all({ ...params, limit: lim, offset });

  // Parse topics JSON
  const parsed = stories.map((s) => ({
    ...s,
    topics: JSON.parse(s.topics || '[]'),
  }));

  res.json({ stories: parsed, total, page: pageNum, pages: Math.ceil(total / lim) });
});

// Archive topic counts
app.get('/api/archive/topics', (req, res) => {
  const rows = db.prepare(`SELECT topics FROM stories WHERE pub_date > datetime('now', '-30 days')`).all();
  const counts = {};
  for (const row of rows) {
    const topics = JSON.parse(row.topics || '[]');
    for (const t of topics) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  res.json(counts);
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`NYC News Engine running at http://localhost:${PORT}`);
  fetchAllFeeds();
});
