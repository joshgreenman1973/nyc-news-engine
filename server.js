const express = require('express');
const Parser = require('rss-parser');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const parser = new Parser({
  timeout: 8000,
  headers: {
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
    'User-Agent': 'Mozilla/5.0 (compatible; NYCNewsEngine/1.0)',
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
  { name: 'Daily News', slug: 'daily-news', tier: 2, url: 'https://news.google.com/rss/search?q=site:nydailynews.com+NYC+OR+%22new+york%22+when:3d&hl=en-US&gl=US&ceid=US:en', site: 'https://www.nydailynews.com', color: '#c53030', tagline: "New York's hometown paper" },
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
  // Tier 2 — State politics & Albany coverage
  { name: 'Politico NY', slug: 'politico-ny', tier: 2, url: 'https://rss.politico.com/new-york-playbook.xml', site: 'https://www.politico.com/new-york', color: '#be123c', tagline: 'Albany & City Hall insider' },
  { name: 'City & State', slug: 'city-state', tier: 2, url: 'https://www.cityandstateny.com/rss/all/', site: 'https://www.cityandstateny.com', color: '#0e7490', tagline: 'NY government & politics' },
  // Tier 2 — National with NYC filter
  { name: 'Wall Street Journal', slug: 'wsj', tier: 2, url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml', site: 'https://www.wsj.com', color: '#0a0a0a', tagline: 'Business & policy' },
  // Tier 1 — Commentary & interviews
  { name: 'City Journal', slug: 'city-journal', tier: 1, url: 'https://news.google.com/rss/search?q=site:city-journal.org+NYC+OR+%22new+york%22+when:14d&hl=en-US&gl=US&ceid=US:en', site: 'https://www.city-journal.org', color: '#1e3a5f', tagline: 'Manhattan Institute urban policy' },
  { name: 'NY Editorial Board', slug: 'ny-editorial-board', tier: 1, url: 'https://nyeditorialboard.substack.com/feed', site: 'https://nyeditorialboard.substack.com', color: '#b45309', tagline: 'NYC interviews & commentary' },
  // Tier 1 — NYC policy newsletters (Substack & others)
  { name: 'NYC Politics 101', slug: 'nyc-politics-101', tier: 1, url: 'https://nycpolitics101.substack.com/feed', site: 'https://nycpolitics101.substack.com', color: '#6366f1', tagline: 'State & local policy education' },
  { name: 'NYC Policy Forum', slug: 'nyc-policy-forum', tier: 1, url: 'https://nycpolicyforum.substack.com/feed', site: 'https://nycpolicyforum.substack.com', color: '#0284c7', tagline: 'Expert policy debate & commentary' },
  { name: 'Maximum New York', slug: 'maximum-ny', tier: 1, url: 'https://www.maximumnewyork.com/feed', site: 'https://www.maximumnewyork.com', color: '#f59e0b', tagline: 'Pro-growth NYC housing & development' },
  { name: 'Abundance New York', slug: 'abundance-ny', tier: 1, url: 'https://abundanceny.substack.com/feed', site: 'https://abundanceny.substack.com', color: '#10b981', tagline: 'Building more in New York' },
  { name: 'NYCuriosity', slug: 'nycuriosity', tier: 1, url: 'https://nycuriosity.substack.com/feed', site: 'https://nycuriosity.substack.com', color: '#8b5cf6', tagline: 'NYC civic engagement & community boards' },
  { name: 'Sidewalk Chorus', slug: 'sidewalk-chorus', tier: 1, url: 'https://www.sidewalkchorus.com/feed', site: 'https://www.sidewalkchorus.com', color: '#ec4899', tagline: 'NYC neighborhoods & urban life' },
  { name: 'City Journal (Substack)', slug: 'city-journal-sub', tier: 1, url: 'https://cityjournal.substack.com/feed', site: 'https://cityjournal.substack.com', color: '#1e3a5f', tagline: 'Manhattan Institute policy newsletter' },
  { name: 'The Bigger Apple', slug: 'bigger-apple', tier: 1, url: 'https://thebiggerapple.manhattan.institute/feed', site: 'https://thebiggerapple.manhattan.institute', color: '#dc2626', tagline: 'Manhattan Institute weekly NYC policy brief' },
  { name: 'Political Currents', slug: 'political-currents', tier: 1, url: 'https://rosselliotbarkan.com/feed', site: 'https://rosselliotbarkan.com', color: '#7c3aed', tagline: 'Ross Barkan on NYC politics & culture' },
  { name: 'Metro Mosaic', slug: 'metro-mosaic', tier: 1, url: 'https://metromosaic.substack.com/feed', site: 'https://metromosaic.substack.com', color: '#0891b2', tagline: 'NYC housing & urban policy analysis' },
  { name: 'Gotham Gazette', slug: 'gotham-gazette', tier: 1, url: 'https://www.gothamgazette.com/rss', site: 'https://www.gothamgazette.com', color: '#b45309', tagline: 'Nonpartisan NYC government & policy' },
];

// ─── Civic / watchdog organizations (separate from news outlets) ──────
const CIVIC_ORGS = [
  { name: 'NYC Comptroller', slug: 'comptroller', url: 'https://comptroller.nyc.gov/feed/', site: 'https://comptroller.nyc.gov', color: '#2563eb' },
  { name: 'Reinvent Albany', slug: 'reinvent-albany', url: 'https://reinventalbany.org/feed/', site: 'https://reinventalbany.org', color: '#16a34a' },
  { name: 'Fiscal Policy Institute', slug: 'fpi', url: 'https://fiscalpolicy.org/feed', site: 'https://fiscalpolicy.org', color: '#0891b2' },
  { name: 'NYC Council', slug: 'nyc-council', url: 'https://council.nyc.gov/feed/', site: 'https://council.nyc.gov', color: '#4f46e5' },
  { name: 'Citizens Budget Commission', slug: 'cbc', url: 'https://news.google.com/rss/search?q=%22citizens+budget+commission%22+when:30d&hl=en-US&gl=US&ceid=US:en', site: 'https://cbcny.org', color: '#0d9488' },
  { name: 'Manhattan Institute', slug: 'manhattan-inst', url: 'https://news.google.com/rss/search?q=site:manhattan.institute+when:30d&hl=en-US&gl=US&ceid=US:en', site: 'https://manhattan.institute', color: '#dc2626' },
  { name: 'Center for an Urban Future', slug: 'cuf', url: 'https://news.google.com/rss/search?q=site:nycfuture.org+when:60d&hl=en-US&gl=US&ceid=US:en', site: 'https://nycfuture.org', color: '#ca8a04' },
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

  return matched.slice(0, 3);
}

// ─── Curation scoring ─────────────────────────────────────────────────
// Heavy policy topics — these are the serious subjects that define NYC public policy discourse
// NOTE: sorted longest-first at scoring time to prevent substring double-counting
// (e.g. 'homeless' inside 'homelessness')
const POLICY_TOPICS = [
  'affordable housing', 'public health', 'criminal justice', 'education policy',
  'homelessness', 'homeless', 'eviction', 'tenant', 'shelter system', 'shelter',
  'mental health', 'outreach', 'social worker', 'social service', 'case manager',
  'supportive housing', 'housing first', 'permanent housing', 'public housing',
  'policing', 'surveillance', 'civil rights', 'civil liberties',
  'child welfare', 'foster care', 'juvenile justice',
  'opioid', 'fentanyl', 'overdose', 'harm reduction',
  'reentry', 'recidivism', 'parole', 'probation', 'rikers',
  'food insecurity', 'food pantry', 'snap', 'benefits',
  'disability', 'medicaid', 'health care', 'hospital',
  'poverty', 'low-income', 'cost of living', 'affordability',
  'migrant', 'immigration', 'asylum',
  'transit', 'infrastructure', 'congestion pricing',
  'climate', 'zoning', 'rezoning', 'land use',
  'disparity', 'inequality', 'equity',
  'corruption', 'ethics', 'misconduct',
  'policy', 'legislation', 'budget', 'regulation',
  'reform', 'overhaul',
  'workforce', 'job training', 'wage',
  'NYCHA', 'MTA',
  // Fiscal & spending accountability
  'audit', 'inspector general', 'spending', 'procurement', 'contract',
  'cost overrun', 'taxpayer', 'fiscal', 'deficit', 'revenue',
];

// Investigative signals — strongest reward: original reporting, documents, accountability
const INVESTIGATIVE_SIGNALS = [
  'investigation', 'investigat', 'obtained', 'documents show',
  'records reveal', 'records obtained', 'documents obtained',
  'exposed', 'uncovered', 'accountability',
  'FOIA', 'FOIL', 'public records',
  'months-long', 'year-long', 'yearlong', 'multi-year',
  'series', 'part 1', 'part 2', 'part 3',
  'special report', 'exclusive',
  'exposed', 'whistleblow', 'misconduct',
  'data analysis', 'data shows', 'data reveal',
  'first reported', 'first to report',
];

// Explanatory signals — strong reward: context, depth, making policy legible
const EXPLANATORY_SIGNALS = [
  'analysis', 'explained', 'explainer', 'what you need to know',
  'how it works', 'what it means', 'why it matters',
  'deep dive', 'in depth', 'in-depth',
  'behind the', 'inside the', 'the story behind',
  'long read', 'feature', 'reported essay',
  'first-person', 'oral history', 'profile',
  'how we got here', 'a closer look', 'unpacking',
  'the case for', 'the case against',
  'what went wrong', 'lessons from', 'what happened',
  // Accountability follow-up — checking back on promises and programs
  'months later', 'one year after', 'years later',
  'still hasn\'t', 'still has not', 'failed to implement',
  'promised but', 'remains unfulfilled', 'has yet to',
  'follow-up', 'revisited', 'where things stand',
];

// General depth signals — lighter weight, reward craft and governance focus
const DEPTH_SIGNALS = [
  'community', 'neighborhood', 'borough', 'council',
  'city hall', 'Albany', 'state legislature',
  'mayor', 'governor', 'comptroller', 'public advocate', 'speaker',
  'political', 'power broker',
  'census', 'demographic', 'population',
  'effectiveness', 'program', 'initiative', 'labor',
  // Government action — light weight so procedural votes don't outrank exposés
  'passed', 'approved', 'vetoed', 'signed into law',
  'executive order', 'proposed rule', 'public hearing', 'testimony',
  'enacted', 'adopted', 'introduced a bill',
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
  // Rebroadcast / repackaged / entertainment segments
  'best of:', 'rebroadcast', 'encore presentation',
  'prime video', 'netflix', 'hulu', 'streaming',
  'new album', 'new book', 'memoir',
  'actor ', 'actress', 'musician', 'singer', 'comedian',
  'r&b', 'hip hop', 'hip-hop', 'rock star',
];

// Soft-news / lifestyle / sports signals → heavy penalty to keep out of Today's Picks
const SOFT_NEWS_SIGNALS = [
  'kids reporter', 'yes network', 'celebrity', 'real housewives',
  'restaurant review', 'best restaurants', 'best bars', 'food hall',
  'broadway', 'theater review', 'movie review', 'book review',
  'fashion', 'style', 'recipe', 'cooking',
  'mets', 'yankees', 'knicks', 'nets', 'rangers', 'islanders',
  'giants', 'jets', 'nycfc', 'red bulls', 'liberty',
  'game recap', 'box score', 'free agent', 'trade deadline',
  'draft pick', 'spring training', 'preseason', 'playoff',
  'concert', 'festival', 'nightlife', 'club', 'bar opening',
  'dating', 'relationship', 'horoscope', 'astrology',
  'best places to', 'things to do', 'weekend guide', 'where to eat',
  'listicle', 'bucket list', 'hidden gem',
  'puppy', 'dog park', 'cat cafe', 'pet',
  'viral', 'tiktok', 'instagram', 'influencer',
  'reality tv', 'reality show', 'bachelor', 'survivor',
  'oscars', 'academy awards', 'emmy', 'grammy', 'golden globe', 'tony awards',
  'red carpet', 'award show', 'awards ceremony', 'super bowl halftime',
  'bay area', 'los angeles', 'hollywood', 'conan o\'brien',
  'kardashian', 'taylor swift', 'beyonce', 'drake',
];

function scoreStory(item, outlet) {
  let score = 0;
  const combined = `${item.title} ${item.snippet || ''}`.toLowerCase();

  if (outlet.tier === 1) score += 12;
  else if (outlet.tier === 2) score += 8;
  else if (outlet.tier === 3) score += 2;

  // Policy topic hits — serious subjects get heavy weight
  // Sort longest-first so 'homelessness' matches before 'homeless',
  // then skip any term that is a substring of an already-matched term
  const sortedTopics = [...POLICY_TOPICS].sort((a, b) => b.length - a.length);
  const matchedTerms = [];
  let policyHits = 0;
  for (const s of sortedTopics) {
    const lower = s.toLowerCase();
    if (!combined.includes(lower)) continue;
    if (matchedTerms.some(m => m.includes(lower))) continue;
    matchedTerms.push(lower);
    score += 8;
    policyHits++;
  }
  // Compound bonus: stories hitting multiple policy topics are deeply relevant
  if (policyHits >= 4) score += 15;
  else if (policyHits >= 3) score += 10;
  else if (policyHits >= 2) score += 6;

  // Investigative signals — heavy weight, this is the journalism we most want to surface
  let investigativeHits = 0;
  for (const s of INVESTIGATIVE_SIGNALS) {
    if (combined.includes(s.toLowerCase())) { score += 8; investigativeHits++; }
  }
  if (investigativeHits >= 3) score += 15;
  else if (investigativeHits >= 2) score += 10;
  else if (investigativeHits >= 1) score += 5;

  // Explanatory signals — strong weight, context and depth matter
  let explanatoryHits = 0;
  for (const s of EXPLANATORY_SIGNALS) {
    if (combined.includes(s.toLowerCase())) { score += 6; explanatoryHits++; }
  }
  if (explanatoryHits >= 3) score += 12;
  else if (explanatoryHits >= 2) score += 7;
  else if (explanatoryHits >= 1) score += 3;

  // General depth signals — lighter weight, reward governance focus
  let depthHits = 0;
  for (const s of DEPTH_SIGNALS) {
    if (combined.includes(s.toLowerCase())) { score += 4; depthHits++; }
  }
  if (depthHits >= 3) score += 5;
  else if (depthHits >= 2) score += 3;

  for (const s of SHALLOW_SIGNALS) {
    if (combined.includes(s.toLowerCase())) score -= 12;
  }
  for (const s of SOFT_NEWS_SIGNALS) {
    if (combined.includes(s.toLowerCase())) { score -= 20; break; }
  }

  // NYC-locality bonus — reward stories explicitly about NYC governance & place
  const link = (item.link || '').toLowerCase();
  if (link.includes('/nyregion/') || link.includes('/nyc/') || link.includes('/new-york/')) {
    score += 4;
  }
  const NYC_LOCALITY = [
    'new york city', 'nyc', 'city hall', 'city council', 'albany',
    'brooklyn', 'manhattan', 'queens', 'bronx', 'staten island',
    'nypd', 'mta', 'nycha', 'rikers', 'adams', 'hochul',
    'de blasio', 'comptroller', 'public advocate',
  ];
  let nycHits = 0;
  for (const loc of NYC_LOCALITY) {
    if (combined.includes(loc)) nycHits++;
  }
  if (nycHits >= 3) score += 8;
  else if (nycHits >= 2) score += 5;
  else if (nycHits >= 1) score += 2;

  // State-city intersection bonus — both mayor and governor means
  // intergovernmental policy tension, which is always significant
  const mentionsMayor = combined.includes('mayor') || combined.includes('adams') || combined.includes('city hall');
  const mentionsGovernor = combined.includes('governor') || combined.includes('hochul') || combined.includes('albany');
  if (mentionsMayor && mentionsGovernor) score += 10;

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

  // Flag: does this story have any policy substance?
  // Stories without at least one policy topic, investigative signal,
  // or explanatory signal should never make Today's Picks
  const hasPolicySubstance = policyHits > 0 || investigativeHits > 0 || explanatoryHits > 0;

  return { score: Math.max(0, score), hasPolicySubstance };
}

function classifyRank(score) {
  if (score >= 35) return 'essential';
  if (score >= 22) return 'notable';
  if (score >= 12) return 'standard';
  return 'brief';
}

// ─── Analysis / commentary detection ──────────────────────────────────
// Outlets whose content is almost entirely analysis/commentary
// Vital City removed: its reported features and explainers should compete
// for Today's Picks. Individual stories still get flagged as analysis
// when they trigger analysis signals (op-ed, essay, the case for, etc.)
const ANALYSIS_OUTLETS = ['city-journal', 'city-journal-sub', 'nyc-policy-forum', 'nyc-politics-101', 'maximum-ny', 'abundance-ny', 'nycuriosity', 'sidewalk-chorus', 'bigger-apple', 'political-currents', 'metro-mosaic', 'gotham-gazette', 'ny-editorial-board'];

// Newsletter / Substack outlets — shown in their own sidebar section
const NEWSLETTER_SLUGS = ['nyc-politics-101', 'nyc-policy-forum', 'maximum-ny', 'abundance-ny', 'nycuriosity', 'sidewalk-chorus', 'city-journal-sub', 'bigger-apple', 'political-currents', 'metro-mosaic', 'ny-editorial-board'];

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

// Opinion signals — these mark pieces that should NEVER reach Today's Picks.
// Distinct from analysis: a reported explainer on SEQRA is analysis but not opinion.
// An op-ed arguing "we need to fix SEQRA" is opinion.
const OPINION_SIGNALS = [
  'opinion', 'op-ed', 'oped', 'editorial', 'commentary',
  'guest essay', 'column', 'perspective', 'viewpoint',
  'letter to the editor', 'letter to',
  'the case for', 'the case against',
  'in defense of', 'a better way',
  'we need to', 'it\'s time to', 'we must', 'we should',
  'how to fix', 'how to think about',
];
const OPINION_CATEGORIES = [
  'opinion', 'commentary', 'editorial', 'op-ed', 'oped',
  'columns', 'perspectives', 'viewpoints', 'letters',
];

// Category tags from RSS that signal opinion/analysis
const ANALYSIS_CATEGORIES = [
  'opinion', 'commentary', 'analysis', 'editorial', 'op-ed',
  'columns', 'essays', 'perspectives', 'ideas', 'viewpoints',
  'explainers', 'policy', 'debate',
];

function isAnalysisStory(item, outlet) {
  // Outlets that are almost entirely analysis/commentary/newsletters
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

// Opinion detection — stricter than analysis. Opinion pieces stay in the
// sidebar and never reach Today's Picks. Reported analysis/explainers
// (data-driven, investigative, explanatory) CAN reach Today's Picks.
function isOpinionStory(item, outlet) {
  const titleLower = (item.title || '').toLowerCase();
  const snippetLower = (item.snippet || '').toLowerCase();
  const combined = titleLower + ' ' + snippetLower;
  const categories = (item.categories || []).map((c) =>
    (typeof c === 'string' ? c : String(c)).toLowerCase()
  );

  // Category tags are the strongest signal
  for (const cat of categories) {
    if (OPINION_CATEGORIES.some((oc) => cat.includes(oc))) return true;
  }

  // Title/snippet signals — need clear opinion language
  for (const signal of OPINION_SIGNALS) {
    if (combined.includes(signal)) return true;
  }

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

  // Strip photo/image captions that lead snippets
  clean = clean.replace(/^(File photo|Photo|Image|Video|Listen|Watch)(\s+(from|by|courtesy|of|via|credit|:)).*?[.!]\s*/i, '');
  clean = clean.replace(/^(A|An)\s+(file\s+)?photo\s+(from|of|showing).*?[.!]\s*/i, '');
  clean = clean.replace(/^(Credit|Getty|AP|Reuters|EPA|AFP)[^.]*[.]\s*/i, '');

  return clean.substring(0, 350);
}

async function fetchFeed(outlet) {
  if (!outlet.url) {
    return { outlet, items: [], error: 'No RSS feed available' };
  }
  try {
    const feed = await parser.parseURL(outlet.url);
    let items = (feed.items || []).slice(0, 20).map((item) => {
      const title = item.title || 'Untitled';
      const link = item.link || '';
      const snippet = cleanSnippet(item.contentSnippet || item.content || '');
      const author = item.creator || item['dc:creator'] || item.author || null;
      const rawCats = item.categories || [];
      const cats = rawCats.map((c) => (typeof c === 'string' ? c : (c._ || c.$ || String(c))));
      let pubDate = item.pubDate || item.isoDate || null;
      // Clamp future dates to now — some feeds pre-publish with tomorrow's date
      if (pubDate && new Date(pubDate).getTime() > Date.now()) {
        pubDate = new Date().toISOString();
      }

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

      const result = scoreStory(story, outlet);
      story.score = result.score;
      story.hasPolicySubstance = result.hasPolicySubstance;
      story.rank = classifyRank(story.score);
      story.isAnalysis = isAnalysisStory(story, outlet);
      story.isOpinion = isOpinionStory(story, outlet);

      return story;
    });

    // WNYC's feed mixes news with BBC bulletins, concert listings, and podcast reruns — filter aggressively
    // Brian Lehrer episodes are already captured in the podcasts section
    if (outlet.slug === 'wnyc') {
      const junkPatterns = [
        /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\s+GMT/i,  // BBC World Service timestamps ("13/03/2026 02:01 GMT")
        /\bat\s+92NY\b/i,                                // 92NY concert listings
        /gig-alerts\.simplecast/i,                        // Concert alert links
        /\bBBC\b/i,                                       // All BBC content
        /\bPBS\s+News\s+Hour\b/i,                         // PBS national broadcast
        /\bLatest\s+Newscast\s+From\b/i,                  // Generic WNYC newscast placeholder
        /\bBest\s+Of:/i,                                   // Rebroadcast compilations (already in podcasts)
        /\bAll\s+Of\s+It\b/i,                              // Arts & culture show
        /\bNew\s+Sounds\b/i,                               // Music show
        /\bSoundcheck\b/i,                                 // Music show
      ];
      items = items.filter(s => {
        const combined = `${s.title} ${s.link}`;
        return !junkPatterns.some(p => p.test(combined));
      });
    }

    // For national outlets, filter to NYC-relevant stories only
    const nycOnlyFilter = ['propublica', 'bolts', 'the-trace', 'the-markup', 'nymag', 'new-yorker', 'wsj', 'ny-post', 'abc7', 'pix11', 'amny'];
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
let fetchInProgress = null;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchAllFeeds() {
  const now = Date.now();
  if (lastFetchTime && now - lastFetchTime < CACHE_TTL && curatedCache) {
    return { feeds: feedCache, curated: curatedCache };
  }
  // Prevent concurrent fetches — reuse in-flight promise
  if (fetchInProgress) return fetchInProgress;
  fetchInProgress = _doFetchAllFeeds(now);
  try { return await fetchInProgress; } finally { fetchInProgress = null; }
}

async function _doFetchAllFeeds(now) {

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
  // Sort by score, then by snippet length as tiebreaker (longer = deeper coverage)
  // so when dedup removes near-duplicates, the deepest version survives
  const sorted = allStories
    .filter((s) => s.link && s.title !== 'Untitled')
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.snippet || '').length - (a.snippet || '').length;
    });

  // ── Deduplication ──
  // Extract significant words from a title (drop common short words)
  const STOP_WORDS = new Set(['a','an','the','and','or','but','in','on','at','to','for','of','is','it','by','as','its','with','from','was','are','has','had','how','why','what','who','that','this','will','can','not','be','do','no','new','says','say','said','over','after','into','than','may','more','could','would','about','just','been','have','also','some','when','out','all','up']);
  function titleWords(title) {
    return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }
  // Jaccard similarity on significant words
  function titleSimilarity(wordsA, wordsB) {
    if (wordsA.length === 0 || wordsB.length === 0) return 0;
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    let intersection = 0;
    for (const w of setA) { if (setB.has(w)) intersection++; }
    return intersection / (setA.size + setB.size - intersection);
  }

  const deduped = [];
  const dedupedWords = [];
  for (const story of sorted) {
    const words = titleWords(story.title);
    // Check if this story is too similar to one already kept
    let isDupe = false;
    for (const existing of dedupedWords) {
      if (titleSimilarity(words, existing) >= 0.5) { isDupe = true; break; }
    }
    if (!isDupe) {
      deduped.push(story);
      dedupedWords.push(words);
    }
  }

  // Separate analysis/commentary from news stories for sidebar sections
  const analysisPool = deduped.filter((s) => s.isAnalysis && s.score >= 15);

  // News pool: everything that isn't routed to analysis sidebar
  // PLUS non-opinion analysis pieces (reported explainers can compete for Today's Picks)
  const newsPool = deduped.filter((s) => !s.isAnalysis);

  // Split newsletters out of analysis pool into their own section
  const newsletterPool = analysisPool.filter((s) => NEWSLETTER_SLUGS.includes(s.outletSlug));
  const pureAnalysisPool = analysisPool.filter((s) => !NEWSLETTER_SLUGS.includes(s.outletSlug));

  const newsletters = newsletterPool.slice(0, 8);
  const analysis = pureAnalysisPool.slice(0, 10);
  const analysisIds = new Set([...analysis.map((s) => s.id), ...newsletters.map((s) => s.id)]);

  // Today's Picks: only stories from last 36 hours
  // Sort candidates by a display score that heavily rewards freshness
  // so this morning's stories beat yesterday's high-scorers
  const FRESHNESS_CUTOFF = 36 * 3600 * 1000;
  const nowMs = Date.now();

  const essentialCandidates = newsPool.filter(s => {
    if (analysisIds.has(s.id)) return false;
    if (s.rank !== 'essential') return false;
    // Gate: stories without any policy, investigative, or explanatory
    // substance never belong in Today's Picks regardless of score
    if (!s.hasPolicySubstance) return false;
    // Opinion pieces (op-eds, editorials, columns) stay in the sidebar —
    // only reported analysis/explainers can reach Today's Picks
    if (s.isOpinion) return false;
    const age = s.pubDate ? nowMs - new Date(s.pubDate).getTime() : Infinity;
    return age < FRESHNESS_CUTOFF;
  });

  // Display sort: big freshness boost so recent stories surface to top
  essentialCandidates.sort((a, b) => {
    const ageA = a.pubDate ? (nowMs - new Date(a.pubDate).getTime()) / 3600000 : 999;
    const ageB = b.pubDate ? (nowMs - new Date(b.pubDate).getTime()) / 3600000 : 999;
    // Bonus: +20 if <3h, +12 if <6h, +6 if <12h
    const freshA = ageA < 3 ? 20 : ageA < 6 ? 12 : ageA < 12 ? 6 : 0;
    const freshB = ageB < 3 ? 20 : ageB < 6 ? 12 : ageB < 12 ? 6 : 0;
    return (b.score + freshB) - (a.score + freshA);
  });

  // Per-outlet caps: tight for high-volume outlets, generous for others
  const OUTLET_CAP = { 'documented': 2, 'ny-post': 2, 'abc7': 2, 'el-diario': 2 };
  const DEFAULT_CAP = 3;

  const essential = [];
  const outletCount = {};
  for (const s of essentialCandidates) {
    if (essential.length >= 13) break;
    const slug = s.outletSlug;
    outletCount[slug] = (outletCount[slug] || 0);
    const cap = OUTLET_CAP[slug] || DEFAULT_CAP;
    if (outletCount[slug] < cap) {
      essential.push(s);
      outletCount[slug]++;
    }
  }

  const essentialIds = new Set(essential.map(s => s.id));
  const notable = [];
  const standard = [];

  for (const s of newsPool) {
    if (analysisIds.has(s.id) || essentialIds.has(s.id)) continue;
    if (s.rank === 'notable' && notable.length < 15) {
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

  // ─── Civic / watchdog reports ───
  const civicReports = [];
  for (const org of CIVIC_ORGS) {
    try {
      const feed = await parser.parseURL(org.url);
      if (feed.items && feed.items.length > 0) {
        for (const item of feed.items.slice(0, 3)) {
          civicReports.push({
            org: org.name,
            orgSlug: org.slug,
            orgColor: org.color,
            orgSite: org.site,
            title: item.title || 'Untitled',
            link: item.link || org.site,
            pubDate: item.pubDate || item.isoDate || null,
            snippet: (item.contentSnippet || item.content || '').replace(/<[^>]+>/g, '').substring(0, 180),
          });
        }
      }
    } catch (e) {
      console.log(`Error fetching civic org ${org.name}: ${e.message}`);
    }
  }
  // Sort by date descending, filter junk, cap at 8
  const filteredCivic = civicReports
    .filter(r => {
      // Filter out Google News junk (non-English spam, very short titles)
      if (!r.title || r.title.length < 10) return false;
      if (/[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]/.test(r.title)) return false; // non-Latin chars
      if (r.title.toLowerCase().includes('tag:')) return false;
      // Filter out archive pages, author indexes, category pages
      const lower = r.title.toLowerCase();
      if (/\barchives?\b/.test(lower) && !lower.includes('report')) return false;
      if (/\b(all posts|all articles|browse by|category:|topic:)\b/.test(lower)) return false;
      // Filter links that look like index/tag/archive URLs rather than articles
      const link = (r.link || '').toLowerCase();
      if (/\/(tag|category|author|archives?)\/?$/.test(link)) return false;
      if (/\/(tag|category|author)\/[^/]+\/?$/.test(link) && !link.includes('-20')) return false;
      return true;
    })
    .sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0))
    .slice(0, 8);

  // ─── Social buzz — Reddit + Google News trending ───
  let socialBuzz = [];
  try {
    const buzzItems = [];

    // Reddit: hot posts from r/nyc + r/newyorkcity (single multi-sub request)
    const redditUrl = 'https://www.reddit.com/r/nyc+newyorkcity/hot.json?limit=30';
    const redditResp = await fetch(redditUrl, {
      headers: { 'User-Agent': 'NYCNewsEngine/1.0 (policy journalism aggregator)' },
      signal: AbortSignal.timeout(8000),
    });
    if (redditResp.ok) {
      const redditData = await redditResp.json();
      const posts = (redditData?.data?.children || []).map(c => c.data);
      for (const p of posts) {
        // Skip self-posts, images, stickied, and low-engagement
        if (p.is_self || p.stickied) continue;
        if ((p.score || 0) < 15 && (p.num_comments || 0) < 8) continue;
        // Skip image/video posts
        const domain = (p.domain || '').toLowerCase();
        if (/reddit\.com|imgur|i\.redd\.it|v\.redd\.it|youtube|youtu\.be|gfycat|streamable/.test(domain)) continue;
        buzzItems.push({
          title: (p.title || '').substring(0, 140),
          link: p.url || `https://reddit.com${p.permalink}`,
          source: 'reddit',
          subreddit: p.subreddit,
          score: p.score || 0,
          comments: p.num_comments || 0,
          engagement: (p.score || 0) + (p.num_comments || 0) * 2,
          pubDate: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
          discussionUrl: `https://reddit.com${p.permalink}`,
        });
      }
    }

    // Google News: trending NYC stories (last 2 days)
    const gnUrl = 'https://news.google.com/rss/search?q=NYC+OR+%22new+york+city%22+when:2d&hl=en-US&gl=US&ceid=US:en';
    try {
      const gnFeed = await parser.parseURL(gnUrl);
      for (const item of (gnFeed.items || []).slice(0, 12)) {
        if (!item.title || !item.link) continue;
        buzzItems.push({
          title: (item.title || '').substring(0, 140),
          link: item.link,
          source: 'google-news',
          score: 0,
          comments: 0,
          engagement: 0,
          pubDate: item.pubDate || item.isoDate || null,
          discussionUrl: null,
        });
      }
    } catch (gnErr) {
      console.log(`Google News trending fetch failed: ${gnErr.message}`);
    }

    // Deduplicate across sources using same Jaccard approach
    const buzzStopWords = new Set(['a','an','the','and','or','but','in','on','at','to','for','of','is','it','by','as','its','with','from','was','are','has','had','how','why','what','who','that','this','will','can','not','be','do','no','new','says','say','said','over','after','into','than','may','more','could','would','about','just','been','have','also','some','when','out','all','up']);
    function buzzWords(t) {
      return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !buzzStopWords.has(w));
    }
    function buzzSimilarity(a, b) {
      if (!a.length || !b.length) return 0;
      const setA = new Set(a), setB = new Set(b);
      let inter = 0;
      for (const w of setA) { if (setB.has(w)) inter++; }
      return inter / (setA.size + setB.size - inter);
    }

    // Sort: Reddit items by engagement, Google News by position (already ordered by relevance)
    buzzItems.sort((a, b) => b.engagement - a.engagement);

    const kept = [];
    const keptWords = [];
    for (const item of buzzItems) {
      const words = buzzWords(item.title);
      if (keptWords.some(kw => buzzSimilarity(words, kw) >= 0.45)) continue;
      // Also deduplicate against main story titles
      if (dedupedWords.some(dw => buzzSimilarity(words, dw) >= 0.45)) continue;
      kept.push(item);
      keptWords.push(words);
      if (kept.length >= 6) break;
    }
    socialBuzz = kept;
    console.log(`  Social buzz: ${socialBuzz.length} items (${buzzItems.length} raw from Reddit + Google News)`);
  } catch (buzzErr) {
    console.log(`Social buzz fetch failed (non-fatal): ${buzzErr.message}`);
    socialBuzz = [];
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

  curatedCache = { essential, notable, standard, analysis, newsletters, headlines, podcasts, civicReports: filteredCivic, socialBuzz, latest, totalScored: deduped.length, topicCounts };
  feedCache = feeds;
  lastFetchTime = now;

  console.log(`  Curated: ${essential.length} essential, ${analysis.length} analysis, ${newsletters.length} newsletters, ${notable.length} notable out of ${deduped.length} stories`);
  return { feeds, curated: curatedCache };
}

// ─── API routes ───────────────────────────────────────────────────────

// ─── Translation endpoint ─────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  try {
    const { text, to = 'en' } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Missing text' });

    // Use Google's free translate API endpoint
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`Translate API ${resp.status}`);

    const data = await resp.json();
    // Response format: [[["translated text","original text",null,null,N],...],null,"detected_lang"]
    const translated = data[0].map(seg => seg[0]).join('');
    const detectedLang = data[2] || 'unknown';
    res.json({ translated, detectedLang });
  } catch (err) {
    console.error('Translation error:', err.message);
    res.status(500).json({ error: 'Translation failed' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', stories: curatedCache?.totalScored || 0, lastUpdated: lastFetchTime ? new Date(lastFetchTime).toISOString() : null });
});

app.get('/api/feeds', async (req, res) => {
  try {
    // If cache is warm, return immediately
    if (curatedCache && feedCache && Object.keys(feedCache).length > 0) {
      return res.json({ feeds: feedCache, curated: curatedCache, lastUpdated: lastFetchTime ? new Date(lastFetchTime).toISOString() : null, outlets: OUTLETS });
    }
    // Cache not ready — wait for the initial fetch (only happens on cold start)
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
  // Keep cache warm — refresh every 5 minutes in the background
  setInterval(() => {
    lastFetchTime = null;
    curatedCache = null;
    fetchAllFeeds().catch(err => console.error('Background refresh error:', err.message));
  }, 5 * 60 * 1000);
});
