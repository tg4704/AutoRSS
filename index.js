import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFile, writeFile } from 'node:fs/promises';

// ── Configuration ──────────────────────────────────────────────────────────────
const RSS_FEEDS          = process.env.RSS_FEEDS;
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY;
const SCORING_CRITERIA   = process.env.SCORING_CRITERIA;
const POSTING_THRESHOLD  = parseInt(process.env.POSTING_THRESHOLD ?? '80', 10);
const BUFFER_API_KEY     = process.env.BUFFER_API_KEY;
const BUFFER_CHANNEL_IDS = process.env.BUFFER_CHANNEL_IDS;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const BUFFER_GRAPHQL_URL = 'https://api.buffer.com/graphql';

// Wide enough to absorb missed/delayed external triggers. Dedup prevents reposts.
const MAX_AGE_MS = 240 * 60 * 1000; // 4 hours
const SNIPPET_MAX_CHARS = 400;

// Gemini resilience: try the primary model, fall back to a second model, and
// retry transient errors (503 overload, 429 rate limit, 500) with backoff.
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash'];
const GEMINI_MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransientGeminiError(err) {
  const msg = String(err?.message ?? '');
  return /\b(429|500|503)\b|overload|high demand|service unavailable|rate limit|try again/i.test(msg);
}

// ── JC special feed ────────────────────────────────────────────────────────────
// Supplemented automatically when the regular pool has fewer than 10 fresh articles.
const JC_RSS_URL        = 'https://jimconnors.net/?format=rss';
const JC_MIN_POOL       = 10;  // trigger threshold
const JC_PICK_COUNT     = 10;  // how many JC articles to add
const JC_NUMBER_RE      = /JC\s*#(\d+)/i;

function extractJCNumber(title) {
  const m = (title ?? '').match(JC_NUMBER_RE);
  return m ? parseInt(m[1], 10) : null;
}

// ── Persistence (posted.json) ──────────────────────────────────────────────────
// Schema v2: { articleKeys: string[], jcUsed: number[] }
// Migrates transparently from the old v1 flat-array format.
const POSTED_DB_PATH    = 'posted.json';
const MAX_POSTED_RECORDS = 500;

async function loadPostedDB() {
  try {
    const raw  = await readFile(POSTED_DB_PATH, 'utf-8');
    const data = JSON.parse(raw);

    // v1 → v2 migration: old file was a plain array of article keys
    if (Array.isArray(data)) {
      console.log('[Dedup] Migrating posted.json from v1 to v2 format.');
      return {
        articleKeys: new Set(data),
        jcUsed:      new Set(),
      };
    }

    return {
      articleKeys: new Set(Array.isArray(data.articleKeys) ? data.articleKeys : []),
      jcUsed:      new Set(Array.isArray(data.jcUsed)      ? data.jcUsed      : []),
    };
  } catch {
    return { articleKeys: new Set(), jcUsed: new Set() };
  }
}

async function savePostedDB(db, { newArticleKey = null, newJcNumber = null } = {}) {
  const articleKeys = [...db.articleKeys];
  if (newArticleKey) articleKeys.push(newArticleKey);

  const jcUsed = [...db.jcUsed];
  if (newJcNumber != null) jcUsed.push(newJcNumber);

  const payload = {
    articleKeys: articleKeys.slice(-MAX_POSTED_RECORDS),
    jcUsed:      jcUsed.slice(-MAX_POSTED_RECORDS),
  };

  await writeFile(POSTED_DB_PATH, JSON.stringify(payload, null, 2));
  console.log(
    `[Dedup] DB saved. articleKeys: ${payload.articleKeys.length}, jcUsed: ${payload.jcUsed.length}.`
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────
// Map a Gemini-scored result back to its original feed item to recover the
// source link, dedup key, and JC metadata (Gemini does not echo these).
function resolveOriginal(winner, articles) {
  if (Number.isInteger(winner.id) && articles[winner.id]) {
    return articles[winner.id];
  }
  return articles.find((a) => a.title === winner.title) ?? null;
}

// Stable per-article identity for regular feeds.
function articleKey(item) {
  return item?.guid || item?.link || item?.title || '';
}

// ── Step 1a: Fetch & time-filter regular RSS feeds ─────────────────────────────
async function fetchAndFilterArticles() {
  const parser = new Parser({
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AutoRSS/1.0; +https://github.com/tg4704/AutoRSS)',
      'Accept':     'application/rss+xml, application/xml, text/xml, */*',
    },
  });

  const feedUrls = RSS_FEEDS.split(',').map(u => u.trim()).filter(Boolean);

  const feedResults = await Promise.all(
    feedUrls.map(async (url) => {
      try {
        const feed = await parser.parseURL(url);
        return feed.items ?? [];
      } catch (err) {
        console.error(`[RSS] Failed to fetch ${url}: ${err.message}`);
        return [];
      }
    })
  );

  const now      = Date.now();
  const allItems = feedResults.flat();

  return allItems.filter((item) => {
    const dateStr = item.isoDate ?? item.pubDate;
    if (!dateStr) return false;
    const pubTime = new Date(dateStr).getTime();
    if (isNaN(pubTime)) return false;
    return now - pubTime <= MAX_AGE_MS;
  });
}

// ── Step 1b: Fetch JC supplement feed ─────────────────────────────────────────
async function fetchJCArticles(jcUsed) {
  const parser = new Parser({
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AutoRSS/1.0; +https://github.com/tg4704/AutoRSS)',
      'Accept':     'application/rss+xml, application/xml, text/xml, */*',
    },
  });

  try {
    const feed  = await parser.parseURL(JC_RSS_URL);
    const items = (feed.items ?? [])
      .map((item) => {
        const jcNumber = extractJCNumber(item.title);
        return { ...item, _isJC: true, _jcNumber: jcNumber };
      })
      .filter((item) => item._jcNumber !== null && !jcUsed.has(item._jcNumber));

    // Shuffle so we don't always pick the most-recent JC articles
    const shuffled = items.sort(() => Math.random() - 0.5);
    const picked   = shuffled.slice(0, JC_PICK_COUNT);

    console.log(
      `[JC] Fetched ${items.length} unused JC article(s). Picking ${picked.length}.`
    );
    return picked;
  } catch (err) {
    console.error(`[JC] Failed to fetch JC feed: ${err.message}`);
    return [];
  }
}

// Calls Gemini with retry + model fallback. Returns the raw JSON text, or
// throws if every model and retry is exhausted.
async function generateWithRetry(prompt) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  let lastErr;

  for (let m = 0; m < GEMINI_MODELS.length; m++) {
    const modelName = GEMINI_MODELS[m];
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json' },
    });

    for (let attempt = 1; attempt <= GEMINI_MAX_RETRIES; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        if (m > 0 || attempt > 1) {
          console.log(`[Gemini] Succeeded with ${modelName} (attempt ${attempt}).`);
        }
        return result.response.text().trim();
      } catch (err) {
        lastErr = err;

        // Permanent errors (bad key, bad request) won't be fixed by retrying.
        if (!isTransientGeminiError(err)) throw err;

        if (attempt < GEMINI_MAX_RETRIES) {
          const delay = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s
          console.warn(
            `[Gemini] ${modelName} transient error (attempt ${attempt}/${GEMINI_MAX_RETRIES}): ` +
            `${err.message}. Retrying in ${delay}ms…`
          );
          await sleep(delay);
        } else {
          console.warn(
            `[Gemini] ${modelName} still failing after ${GEMINI_MAX_RETRIES} attempts. ` +
            (m < GEMINI_MODELS.length - 1 ? 'Trying fallback model…' : 'No models left.')
          );
        }
      }
    }
  }

  throw lastErr;
}

// ── Step 2: Score articles via Gemini ─────────────────────────────────────────
async function scoreArticles(articles) {
  const articlesPayload = articles
    .map((item, i) => {
      const snippet = (item.contentSnippet ?? item.summary ?? '')
        .slice(0, SNIPPET_MAX_CHARS)
        .replace(/\s+/g, ' ')
        .trim();
      return [
        `--- Article (ID: ${i}) ---`,
        `Title:   ${item.title ?? 'N/A'}`,
        `Snippet: ${snippet || 'N/A'}`,
        `Link:    ${item.link ?? 'N/A'}`,
      ].join('\n');
    })
    .join('\n\n');

  const prompt = `You are a creative social media writer for an audience that loves science, tech, and engineering. Your niche: ${SCORING_CRITERIA}

━━━ SCORING ━━━
For each article output:
• id        – the exact integer ID shown
• score     – 0 to 100 (relevance + viral potential + audience value)
• reasoning – one sentence explaining the score

━━━ WRITING THE POST (social_post_text) ━━━
Write a post strictly under 240 characters. Do NOT include any URL.

STRICT RULES — break any of these and the post is rejected:
1. ZERO em dashes (— or –). Never use them. Use a comma, a period, or a line break instead.
2. No repetition. Do not restate the headline. Add something new: context, a question, a comparison, a surprise.
3. Simple everyday language. Write like you are texting a smart friend, not writing a press release.
4. Make the audience feel something: curious, surprised, amused, or slightly mind-blown.
5. End with either a question the audience can actually answer, or a line that makes them stop and think.
6. No hashtags. No "Breaking:" or "NEW:" prefixes. No filler like "Fascinating!" or "Wow!" as standalone words.

WRITING STYLES — you have 6 styles. Pick ONE randomly per article. Vary across the batch (do not use the same style twice in a row):

STYLE 1 — The Everyday Analogy
  Hook: connect the science/tech to something people use daily.
  Example feel: "Your phone charger does X billion times less work than what these researchers just built inside a chip the size of a fingernail. How is that even possible?"

STYLE 2 — The Myth Flip
  Hook: start by stating what people wrongly believe, then flip it.
  Example feel: "We always assumed X was impossible at small scales. Turns out we were just measuring the wrong thing. What else are we getting wrong?"

STYLE 3 — The Surprising Number
  Hook: lead with a specific number or stat that sounds unbelievable.
  Example feel: "68% of new cloud workloads run serverless now. That means the server you imagined is probably not running your favourite app anymore."

STYLE 4 — The Tiny Story
  Hook: put the reader inside the moment with 1-2 vivid sentences, then land the point.
  Example feel: "A briefcase-sized satellite tumbles in orbit. It fires two thrusters at once, one chemical, one electric, and pulls off a manoeuvre that should have been impossible for something that small."

STYLE 5 — The Direct Question
  Hook: open cold with a question that is impossible to scroll past.
  Example feel: "What if the thing slowing down AI was not the model, but the memory chip sitting next to it? That is exactly what this new architecture fixes."

STYLE 6 — The Relatable Comparison
  Hook: compare the discovery to something from daily life so the scale or concept clicks instantly.
  Example feel: "Imagine your WiFi router could think. Not smart-home think. Actually reason, adapt, and reroute itself mid-packet. That is roughly what this chip does, at 10 gigabits per second."

Return ONLY a valid JSON array. No markdown, no extra text. Schema:
[
  {
    "id": 0,
    "title": "Original Article Title",
    "score": 85,
    "reasoning": "Brief evaluation note.",
    "social_post_text": "Post under 240 chars, no URL, no em dash."
  }
]

Articles:
${articlesPayload}`;

  const rawText = await generateWithRetry(prompt);
  return JSON.parse(rawText);
}

// ── Step 4: Post to Buffer via GraphQL ────────────────────────────────────────
const CREATE_POST_MUTATION = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess {
        post {
          id
        }
      }
      ... on MutationError {
        message
      }
    }
  }
`;

async function postToBuffer(channelId, text) {
  const variables = {
    input: {
      text,
      channelId,
      schedulingType: 'automatic',
      mode: 'shareNow',
    },
  };

  const response = await fetch(BUFFER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${BUFFER_API_KEY}`,
    },
    body: JSON.stringify({ query: CREATE_POST_MUTATION, variables }),
  });

  const json = await response.json();

  if (json.errors?.length) {
    console.error(`[Buffer] GraphQL errors for channel ${channelId}:`, JSON.stringify(json.errors));
    return false;
  }

  const outcome = json?.data?.createPost;

  if (outcome?.message) {
    console.error(`[Buffer] MutationError for channel ${channelId}: ${outcome.message}`);
    return false;
  }

  if (outcome?.post?.id) {
    console.log(`[Buffer] Post published to channel ${channelId} → post ID: ${outcome.post.id}`);
    return true;
  }

  console.warn(`[Buffer] Unexpected response shape for channel ${channelId}:`, JSON.stringify(json));
  return false;
}

// ── Step 5: Telegram notifications ───────────────────────────────────────────
const escapeMd = (str) => String(str).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');

async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       message,
        parse_mode: 'MarkdownV2',
      }),
    });
    const json = await res.json();
    if (json.ok) {
      console.log('[Telegram] Notification sent successfully.');
    } else {
      console.warn(`[Telegram] Notification failed (non-fatal): ${json.description}`);
    }
  } catch (err) {
    console.warn(`[Telegram] Notification failed (non-fatal): ${err.message}`);
  }
}

// Success alert — includes a JC badge line when the winner came from the JC feed
async function sendTelegramAlert(score, title, socialPostText, jcNumber = null) {
  const runTime = new Date().toUTCString();
  const jcLine  = jcNumber != null
    ? `*📖 JC Article:* \\#${jcNumber}\n`
    : '';
  const message =
    `✅ *Automated Post Queued\\!*\n\n` +
    `*🕐 Run Time:* ${escapeMd(runTime)}\n` +
    jcLine +
    `*AI Score:* ${score}\n` +
    `*Source Article:* ${escapeMd(title)}\n\n` +
    `*Generated Post:*\n${escapeMd(socialPostText)}`;
  await sendTelegramMessage(message);
}

async function sendTelegramThresholdAlert(topScore, threshold) {
  const runTime = new Date().toUTCString();
  const message =
    `⚠️ *AutoRSS: No articles passed the threshold\\!*\n\n` +
    `*🕐 Run Time:* ${escapeMd(runTime)}\n` +
    `*Threshold:* ${threshold}\n` +
    `*Highest score this run:* ${topScore}\n\n` +
    `_No post was published\\. Consider lowering POSTING\\_THRESHOLD if this keeps happening\\._`;
  await sendTelegramMessage(message);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] AutoRSS run started.`);

  // Load the full persistence DB (article dedup keys + used JC numbers).
  const db = await loadPostedDB();
  console.log(
    `[Dedup] Loaded ${db.articleKeys.size} article key(s), ${db.jcUsed.size} used JC number(s).`
  );

  // ── 1a. Fetch & filter regular feeds ──────────────────────────────────────
  let articles;
  try {
    articles = await fetchAndFilterArticles();
  } catch (err) {
    console.error('[RSS] Fatal error during feed fetch:', err.message);
    process.exit(1);
  }

  if (articles.length === 0) {
    console.log('[RSS] No articles published within the last 4 hours. Exiting.');
    process.exit(0);
  }

  // Deduplicate against posting history.
  const fresh   = articles.filter((a) => !db.articleKeys.has(articleKey(a)));
  const skipped = articles.length - fresh.length;
  if (skipped > 0) {
    console.log(`[Dedup] Skipped ${skipped} already-posted article(s).`);
  }

  // ── 1b. JC supplement — kick in when the regular pool is thin ─────────────
  let pool = fresh;
  if (fresh.length < JC_MIN_POOL) {
    console.log(
      `[JC] Regular pool has ${fresh.length} article(s) (< ${JC_MIN_POOL}). ` +
      `Fetching JC supplement…`
    );
    const jcArticles = await fetchJCArticles(db.jcUsed);
    pool = [...fresh, ...jcArticles];
    console.log(`[JC] Combined pool size: ${pool.length} article(s).`);
  }

  if (pool.length === 0) {
    console.log('[RSS] No fresh articles available after dedup and JC supplement. Exiting.');
    process.exit(0);
  }

  console.log(`[RSS] ${pool.length} article(s) ready for scoring. Sending to Gemini…`);

  // ── 2. AI scoring ──────────────────────────────────────────────────────────
  let scored;
  try {
    scored = await scoreArticles(pool);
  } catch (err) {
    console.error('[Gemini] Fatal error during AI scoring:', err.message);
    process.exit(1);
  }

  console.log(`[Gemini] Received scores for ${scored.length} article(s).`);

  // ── 3. Threshold filter & winner selection ────────────────────────────────
  const passing = scored.filter((a) => a.score >= POSTING_THRESHOLD);

  if (passing.length === 0) {
    const topScore = Math.max(...scored.map((a) => a.score));
    console.log(
      `[Filter] No articles passed threshold ${POSTING_THRESHOLD}. ` +
      `Highest score was ${topScore}. Exiting.`
    );
    await sendTelegramThresholdAlert(topScore, POSTING_THRESHOLD);
    process.exit(0);
  }

  const winner   = passing.reduce((best, curr) => (curr.score > best.score ? curr : best));
  const original = resolveOriginal(winner, pool);

  // Detect whether the winner is a JC article
  const isJC    = original?._isJC === true;
  const jcNumber = isJC ? original._jcNumber : null;

  // JC articles never get a link appended (per spec).
  // Regular articles: append link ~60% of the time for variety.
  const sourceLink      = original?.link ?? '';
  const shouldAppendLink = !isJC && sourceLink && Math.random() < 0.6;
  const postText        = shouldAppendLink
    ? `${winner.social_post_text}\n\n${sourceLink}`
    : winner.social_post_text;

  console.log(`[Filter] Winner:       "${winner.title}"`);
  console.log(`[Filter] Score:        ${winner.score}`);
  console.log(`[Filter] Reason:       ${winner.reasoning}`);
  console.log(`[Filter] JC article:   ${isJC ? `yes (#${jcNumber})` : 'no'}`);
  console.log(`[Filter] Link appended:${shouldAppendLink ? ' yes' : ' no'}`);
  console.log(`[Filter] Post:\n${postText}`);

  // ── 4. Dispatch to Buffer ──────────────────────────────────────────────────
  const channelIds = BUFFER_CHANNEL_IDS.split(',').map((id) => id.trim()).filter(Boolean);

  let anySuccess = false;
  for (const channelId of channelIds) {
    try {
      const ok = await postToBuffer(channelId, postText);
      if (ok) anySuccess = true;
    } catch (err) {
      console.error(`[Buffer] Error posting to channel ${channelId}: ${err.message}`);
    }
  }

  // Persist the dedup record only after at least one channel accepted the post.
  if (anySuccess) {
    try {
      await savePostedDB(db, {
        newArticleKey: isJC ? null : articleKey(original),
        newJcNumber:   isJC ? jcNumber : null,
      });
    } catch (err) {
      console.warn(`[Dedup] Failed to persist DB (non-fatal): ${err.message}`);
    }
  } else {
    console.warn('[Buffer] No channel accepted the post — not recording in history.');
  }

  // ── 5. Telegram alert ──────────────────────────────────────────────────────
  await sendTelegramAlert(winner.score, winner.title, postText, jcNumber);

  console.log(`[${new Date().toISOString()}] AutoRSS run completed.`);
  process.exit(0);
}

main();
