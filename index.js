import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

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

// The brand posts twice a day (11:00 & 17:00 IST). The longest gap between runs is
// 18 hours (17:00 → 11:00 next day), so the window must span it or the morning run would
// miss everything published overnight. 20h adds margin for a delayed/missed trigger.
// Dedup (posted.json) prevents reposts, so re-surfacing already-seen articles is harmless.
const MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours
const SNIPPET_MAX_CHARS = 400;

// Platforms we generate distinct content for. Buffer `service` strings are mapped onto
// these keys at runtime (see resolvePlatformChannels).
const SUPPORTED_PLATFORMS = ['threads', 'x', 'bluesky'];

// Per-platform character budgets for the main post (advisory — enforced via the prompt).
const PLATFORM_LIMITS = { threads: 500, x: 280, bluesky: 300 };

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

  const prompt = `You are a sharp editor curating articles for an audience that loves science, tech, and engineering. Your niche: ${SCORING_CRITERIA}

━━━ SCORING ━━━
Score every article on how well it would perform as a short social post for this audience.
Judge on: relevance to the niche, viral potential, and genuine value/surprise for the reader.

For each article output:
• id        – the exact integer ID shown
• title     – the original article title, echoed back verbatim
• score     – integer 0 to 100
• reasoning – one sentence explaining the score

Return ONLY a valid JSON array. No markdown, no extra text. Schema:
[
  {
    "id": 0,
    "title": "Original Article Title",
    "score": 85,
    "reasoning": "Brief evaluation note."
  }
]

Articles:
${articlesPayload}`;

  const rawText = await generateWithRetry(prompt);
  return JSON.parse(rawText);
}

// ── Step 3b: Write per-platform posts for the winning article ─────────────────
// One Gemini call for the single winner. Produces a distinct main post per platform plus
// optional follow-up replies (posted manually by the operator). The model NEVER emits URLs
// — link placement is owned by the code (see applyLinks) to avoid URL hallucination.
function buildWriterPrompt(original, platforms, hasSourceLink) {
  const snippet = (original.contentSnippet ?? original.summary ?? '')
    .slice(0, SNIPPET_MAX_CHARS)
    .replace(/\s+/g, ' ')
    .trim();

  const platformSpecs = platforms.map((p) => {
    if (p === 'threads') {
      return `- threads: main_post max ${PLATFORM_LIMITS.threads} chars. Front-load the strongest line (Threads truncates after ~4 lines). "replies" is usually an empty array; add one only if there is a genuine follow-up thought.`;
    }
    if (p === 'x') {
      return `- x: main_post max ${PLATFORM_LIMITS.x} chars, NO link. "replies" must contain exactly ONE short lead-in sentence (the source link is attached to it automatically afterward), e.g. "Full breakdown here:" or "Source and the full numbers:".`;
    }
    if (p === 'bluesky') {
      return `- bluesky: write natively, do NOT reuse the Threads/X wording verbatim even if the angle is the same. Each post max ${PLATFORM_LIMITS.bluesky} chars. If the article supports it, prefer a thread: put continuation posts in "replies" (1 to 2 entries). Otherwise leave "replies" empty.`;
    }
    return `- ${p}: main_post is a concise standalone post.`;
  }).join('\n');

  const platformSchema = platforms
    .map((p) => `    "${p}": { "main_post": "...", "replies": [] }`)
    .join(',\n');

  return `You are the content voice for Substrata, a faceless science and engineering brand. Turn ONE article into short social posts that read like a real person reacting to something surprising, not like a news-summary bot.

ARTICLE
Title:   ${original.title ?? 'N/A'}
Summary: ${snippet || 'N/A'}

STEP 1 — FIND THE TENSION
Pick exactly ONE angle, whichever is strongest, and commit to it (do not summarize the whole article):
- A number or fact that contradicts a common assumption
- A detail that raises an unanswered question the article itself does not fully resolve
- A comparison that makes the scale of something click (age, size, speed, cost)

STEP 2 — WRITE THE HOOK
BANNED openings — never use these regardless of fit:
- "Imagine [X]..."
- "We always assumed [X], but..."
- "What if [X]?"
- Any rhetorical question with an obvious one-word answer
Use ONE of these structures instead, and rotate so the platforms do not all use the same one:
- A flat, confident claim stated as fact, then let the surprising detail land in the next sentence
- A specific number stated cold with no setup, then why it matters
- A direct address to the reader's intuition ("Your gut says X. It's wrong.")
- An incomplete thought that invites someone to finish it or push back
End with a genuine invitation to respond that connects specifically to your claim (ask what is missing, ask them to guess before revealing, or take a mild stance someone could disagree with). Do not tack on a generic "what do you think".

STRICT RULES — break any and the post is rejected:
1. ZERO em dashes (— or –). Use a comma, a period, or a line break.
2. Do not restate the headline. Add something new: context, a question, a comparison, a surprise.
3. Simple everyday language, like texting a smart friend, not a press release.
4. Make the reader feel something: curious, surprised, amused, or slightly mind-blown.
5. No hashtags. No "Breaking:"/"NEW:" prefixes. No standalone filler like "Fascinating!" or "Wow!".
6. Put NO URLs or links in ANY field. The system attaches the source link automatically where it belongs.${hasSourceLink ? '' : '\n7. No source link is available for this article, so do NOT reference "the link", "source below", or "read more" anywhere.'}

STEP 3 — ADAPT TO EACH PLATFORM
${platformSpecs}

The main_post for every platform must read as COMPLETE on its own, because replies may not be posted. Replies are genuine follow-ups, never essential context.

STEP 4 — IMAGE
Provide "image_description": a single vivid one-line prompt for an AI-generated image that fits the post, used only if the article has no usable hero image.

OUTPUT — strict JSON, no markdown, no preamble. Include ONLY these platform keys: ${platforms.join(', ')}.
{
  "angle_chosen": "one line naming the single angle you committed to",
  "image_description": "one-line AI image generation prompt",
  "platforms": {
${platformSchema}
  }
}`;
}

async function writePlatformPosts(original, platforms, hasSourceLink) {
  const prompt  = buildWriterPrompt(original, platforms, hasSourceLink);
  const rawText = await generateWithRetry(prompt);
  const parsed  = JSON.parse(rawText);
  if (!parsed || typeof parsed.platforms !== 'object') {
    throw new Error('Writer response missing "platforms" object.');
  }
  return parsed;
}

// ── Buffer helpers: shared GraphQL + channel→platform resolution ──────────────
async function bufferGraphQL(query, variables = {}) {
  const response = await fetch(BUFFER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${BUFFER_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (json.errors?.length) {
    throw new Error(`Buffer GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// Buffer's `service` string → our platform key. Twitter is exposed as "twitter";
// we also accept "x" defensively in case Buffer ever renames it.
function serviceToPlatform(service) {
  const s = String(service ?? '').toLowerCase();
  if (s === 'twitter' || s === 'x') return 'x';
  if (s === 'threads')              return 'threads';
  if (s === 'bluesky')              return 'bluesky';
  return null; // unsupported service (e.g. mastodon, linkedin) — skipped
}

// Resolve the configured BUFFER_CHANNEL_IDS into a { platform: channelId } map by asking
// Buffer which social service each channel belongs to. No labeled env var needed.
async function resolvePlatformChannels(channelIds) {
  const data    = await bufferGraphQL(`{ account { organizations { id } } }`);
  const orgs    = data?.account?.organizations ?? [];
  if (orgs.length === 0) throw new Error('Buffer returned no organizations for this API key.');

  // Gather channels across all orgs so we can look up any configured ID.
  const idToService = new Map();
  for (const org of orgs) {
    const chData = await bufferGraphQL(
      `query Channels($input: ChannelsInput!) { channels(input: $input) { id name service } }`,
      { input: { organizationId: org.id } }
    );
    for (const ch of chData?.channels ?? []) {
      idToService.set(ch.id, ch.service);
    }
  }

  const platformChannels = {};
  for (const id of channelIds) {
    const service  = idToService.get(id);
    const platform = serviceToPlatform(service);
    if (!platform) {
      console.warn(
        `[Buffer] Channel ${id} → service "${service ?? 'unknown'}" is not a supported ` +
        `platform (${SUPPORTED_PLATFORMS.join('/')}). Skipping.`
      );
      continue;
    }
    if (platformChannels[platform]) {
      console.warn(`[Buffer] Multiple channels map to "${platform}"; keeping the first.`);
      continue;
    }
    platformChannels[platform] = id;
    console.log(`[Buffer] Channel ${id} → platform "${platform}".`);
  }
  return platformChannels;
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

// ── Link placement (code owns URLs; the LLM never emits them) ─────────────────
// Given the winner's link (or '' for JC / no-link), attach it per platform rules and
// return { mainPost, replies } ready for posting/delivery.
function applyLinks(platform, content, link) {
  const mainPost = String(content?.main_post ?? '').trim();
  const replies  = Array.isArray(content?.replies)
    ? content.replies.map((r) => String(r).trim()).filter(Boolean)
    : [];

  if (!link) return { mainPost, replies };

  if (platform === 'threads') {
    return { mainPost: `${mainPost}\n\n${link}`, replies };
  }
  if (platform === 'x') {
    // Link rides in the reply so the main tweet stays clean. Guarantee a reply exists.
    const lead = replies[0] ? `${replies[0]}\n${link}` : link;
    return { mainPost, replies: [lead, ...replies.slice(1)] };
  }
  if (platform === 'bluesky') {
    // Link goes on the last thread post; if there's no thread, the main post stays link-free.
    if (replies.length === 0) return { mainPost, replies };
    const last = `${replies[replies.length - 1]}\n${link}`;
    return { mainPost, replies: [...replies.slice(0, -1), last] };
  }
  return { mainPost, replies };
}

// ── Hero image scraping (og:image / twitter:image) ────────────────────────────
async function scrapeHeroImage(articleUrl) {
  if (!articleUrl) return null;
  try {
    const res = await fetch(articleUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AutoRSS/1.0; +https://github.com/tg4704/AutoRSS)' },
      signal:  AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1].trim();
    }
    return null;
  } catch (err) {
    console.warn(`[Image] Hero-image scrape failed (non-fatal): ${err.message}`);
    return null;
  }
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
        link_preview_options: { is_disabled: true },
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

async function sendTelegramPhoto(photoUrl, caption) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        photo:      photoUrl,
        caption:    caption ? caption.slice(0, 1024) : undefined,
      }),
    });
    const json = await res.json();
    if (json.ok) {
      console.log('[Telegram] Hero image sent.');
      return true;
    }
    console.warn(`[Telegram] Photo send failed (non-fatal): ${json.description}`);
    return false;
  } catch (err) {
    console.warn(`[Telegram] Photo send failed (non-fatal): ${err.message}`);
    return false;
  }
}

// Per-platform digest: shows what was auto-posted (main post) plus the replies the operator
// posts manually, the angle, and either confirmation the hero image was sent or an AI image
// generation prompt when no hero image exists.
async function sendTelegramDigest({ score, title, angle, sourceLink, jcNumber, perPlatform, heroSent, imageDescription }) {
  const runTime = new Date().toUTCString();
  const jcLine  = jcNumber != null ? `*📖 JC Article:* \\#${jcNumber}\n` : '';
  const linkLine = sourceLink ? `*🔗 Source:* ${escapeMd(sourceLink)}\n` : '';

  const blocks = perPlatform.map(({ platform, mainPost, replies }) => {
    const label = platform.toUpperCase();
    let block = `━━━ *${escapeMd(label)}* ━━━\n${escapeMd(mainPost)}`;
    if (replies.length > 0) {
      const replyLines = replies
        .map((r, i) => `  ${i + 1}\\. ${escapeMd(r)}`)
        .join('\n');
      block += `\n\n_Reply${replies.length > 1 ? ' thread' : ''} to post manually:_\n${replyLines}`;
    }
    return block;
  }).join('\n\n');

  const imageLine = heroSent
    ? `*🖼 Image:* hero image sent above — attach it to the post\\.`
    : `*🖼 No hero image found\\. Generation prompt:*\n${escapeMd(imageDescription ?? 'N/A')}`;

  const message =
    `✅ *Automated Post Published\\!*\n\n` +
    `*🕐 Run Time:* ${escapeMd(runTime)}\n` +
    jcLine +
    `*AI Score:* ${score}\n` +
    `*Source Article:* ${escapeMd(title)}\n` +
    (angle ? `*🎯 Angle:* ${escapeMd(angle)}\n` : '') +
    linkLine +
    `\n${blocks}\n\n` +
    imageLine;

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
    console.log('[RSS] No articles published within the freshness window. Exiting.');
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

  if (!original) {
    console.error('[Filter] Could not map the winning score back to a source article. Exiting.');
    process.exit(1);
  }

  // Detect whether the winner is a JC article
  const isJC    = original._isJC === true;
  const jcNumber = isJC ? original._jcNumber : null;

  // JC articles carry no shareable source link; regular articles do.
  const sourceLink = isJC ? '' : (original.link ?? '');

  console.log(`[Filter] Winner:     "${winner.title}"`);
  console.log(`[Filter] Score:      ${winner.score}`);
  console.log(`[Filter] Reason:     ${winner.reasoning}`);
  console.log(`[Filter] JC article: ${isJC ? `yes (#${jcNumber})` : 'no'}`);

  // ── 3c. Resolve which Buffer channels map to which platforms ───────────────
  const channelIds = BUFFER_CHANNEL_IDS.split(',').map((id) => id.trim()).filter(Boolean);
  let platformChannels;
  try {
    platformChannels = await resolvePlatformChannels(channelIds);
  } catch (err) {
    console.error('[Buffer] Fatal error resolving channel platforms:', err.message);
    process.exit(1);
  }
  const platforms = SUPPORTED_PLATFORMS.filter((p) => platformChannels[p]);
  if (platforms.length === 0) {
    console.error('[Buffer] No configured channel resolved to a supported platform. Exiting.');
    process.exit(1);
  }
  console.log(`[Buffer] Writing for platforms: ${platforms.join(', ')}`);

  // ── 3d. Write per-platform content for the winner ──────────────────────────
  let written;
  try {
    written = await writePlatformPosts(original, platforms, Boolean(sourceLink));
  } catch (err) {
    console.error('[Gemini] Fatal error during per-platform writing:', err.message);
    process.exit(1);
  }
  console.log(`[Gemini] Angle chosen: ${written.angle_chosen ?? 'N/A'}`);

  // Assemble per-platform posts with links placed by code.
  const perPlatform = platforms.map((platform) => {
    const { mainPost, replies } = applyLinks(platform, written.platforms?.[platform], sourceLink);
    return { platform, channelId: platformChannels[platform], mainPost, replies };
  });

  for (const p of perPlatform) {
    console.log(`[Post] ${p.platform} main:\n${p.mainPost}`);
    if (p.replies.length) console.log(`[Post] ${p.platform} replies (manual): ${p.replies.length}`);
  }

  // ── 4. Dispatch main posts to Buffer (one per platform; replies are manual) ─
  let anySuccess = false;
  for (const { platform, channelId, mainPost } of perPlatform) {
    if (!mainPost) {
      console.warn(`[Buffer] No main post generated for ${platform}; skipping.`);
      continue;
    }
    try {
      const ok = await postToBuffer(channelId, mainPost);
      if (ok) anySuccess = true;
    } catch (err) {
      console.error(`[Buffer] Error posting to ${platform} (${channelId}): ${err.message}`);
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

  // ── 5. Hero image + Telegram digest ────────────────────────────────────────
  const heroUrl  = sourceLink ? await scrapeHeroImage(sourceLink) : null;
  const heroSent = heroUrl ? await sendTelegramPhoto(heroUrl, winner.title) : false;

  await sendTelegramDigest({
    score:            winner.score,
    title:            winner.title,
    angle:            written.angle_chosen,
    sourceLink,
    jcNumber,
    perPlatform,
    heroSent,
    imageDescription: written.image_description,
  });

  console.log(`[${new Date().toISOString()}] AutoRSS run completed.`);
  process.exit(0);
}

// Run only when executed directly (`node index.js`), not when imported (e.g. by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

// Exported for unit testing of the pure helpers.
export { applyLinks, serviceToPlatform, buildWriterPrompt };
