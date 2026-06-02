import Parser from 'rss-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ── Configuration ──────────────────────────────────────────────────────────────
const RSS_FEEDS        = process.env.RSS_FEEDS;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const SCORING_CRITERIA = process.env.SCORING_CRITERIA;
const POSTING_THRESHOLD = parseInt(process.env.POSTING_THRESHOLD ?? '80', 10);
const BUFFER_API_KEY   = process.env.BUFFER_API_KEY;
const BUFFER_CHANNEL_IDS = process.env.BUFFER_CHANNEL_IDS;
const CALLMEBOT_PHONE  = process.env.CALLMEBOT_PHONE;
const CALLMEBOT_API_KEY = process.env.CALLMEBOT_API_KEY;

const BUFFER_GRAPHQL_URL = 'https://api.buffer.com/graphql';
const MAX_AGE_MS = 118 * 60 * 1000; // 1 hour 58 minutes
const SNIPPET_MAX_CHARS = 400;

// ── Step 1: Fetch RSS feeds and filter by publication age ──────────────────────
async function fetchAndFilterArticles() {
  const parser = new Parser();
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

  const now = Date.now();
  const allItems = feedResults.flat();

  const recent = allItems.filter((item) => {
    const dateStr = item.isoDate ?? item.pubDate;
    if (!dateStr) return false;
    const pubTime = new Date(dateStr).getTime();
    if (isNaN(pubTime)) return false;
    return now - pubTime <= MAX_AGE_MS;
  });

  return recent;
}

// ── Step 2: Score articles via Gemini ─────────────────────────────────────────
async function scoreArticles(articles) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: { responseMimeType: 'application/json' },
  });

  const articlesPayload = articles
    .map((item, i) => {
      const snippet = (item.contentSnippet ?? item.summary ?? '')
        .slice(0, SNIPPET_MAX_CHARS)
        .replace(/\s+/g, ' ')
        .trim();
      return [
        `--- Article ${i + 1} ---`,
        `Title:   ${item.title ?? 'N/A'}`,
        `Snippet: ${snippet || 'N/A'}`,
        `Link:    ${item.link ?? 'N/A'}`,
      ].join('\n');
    })
    .join('\n\n');

  const prompt = `You are an expert social media curator specializing in: ${SCORING_CRITERIA}

Evaluate each article below independently against that niche. For every article, output:
• score       – relevance, viral potential, and audience value on a strict 0–100 integer scale
• reasoning   – one concise sentence explaining the score
• social_post_text – a compelling social media post strictly under 280 characters that summarises or reacts to the news, with natural relevant keywords (not spammy)

Return ONLY a valid JSON array. No markdown, no extra text. Schema:
[
  {
    "title": "Original Article Title",
    "score": 85,
    "reasoning": "Brief evaluation note.",
    "social_post_text": "Engaging post under 280 chars."
  }
]

Articles:
${articlesPayload}`;

  const result = await model.generateContent(prompt);
  const rawText = result.response.text().trim();

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
      mode: 'addToQueue',
    },
  };

  const response = await fetch(BUFFER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BUFFER_API_KEY}`,
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
    // MutationError union branch
    console.error(`[Buffer] MutationError for channel ${channelId}: ${outcome.message}`);
    return false;
  }

  if (outcome?.post?.id) {
    console.log(`[Buffer] Post queued for channel ${channelId} → post ID: ${outcome.post.id}`);
    return true;
  }

  console.warn(`[Buffer] Unexpected response shape for channel ${channelId}:`, JSON.stringify(json));
  return false;
}

// ── Step 5: WhatsApp alert via CallMeBot ──────────────────────────────────────
async function sendWhatsAppAlert(score, title, socialPostText) {
  const message =
    `✅ *Automated Post Queued!*\n\n` +
    `*AI Score:* ${score}\n` +
    `*Source Article:* ${title}\n\n` +
    `*Generated Post:*\n${socialPostText}`;

  const url =
    `https://api.callmebot.com/whatsapp.php` +
    `?phone=${encodeURIComponent(CALLMEBOT_PHONE)}` +
    `&text=${encodeURIComponent(message)}` +
    `&apikey=${encodeURIComponent(CALLMEBOT_API_KEY)}`;

  try {
    const res = await fetch(url);
    if (res.ok) {
      console.log('[WhatsApp] Notification sent successfully.');
    } else {
      console.warn(`[WhatsApp] Notification returned HTTP ${res.status} (non-fatal).`);
    }
  } catch (err) {
    console.warn(`[WhatsApp] Notification failed (non-fatal): ${err.message}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] AutoRSS run started.`);

  // ── 1. Fetch & filter ──────────────────────────────────────────────────────
  let articles;
  try {
    articles = await fetchAndFilterArticles();
  } catch (err) {
    console.error('[RSS] Fatal error during feed fetch:', err.message);
    process.exit(1);
  }

  if (articles.length === 0) {
    console.log('[RSS] No articles published within the last 118 minutes. Exiting.');
    process.exit(0);
  }

  console.log(`[RSS] ${articles.length} recent article(s) found. Sending to Gemini…`);

  // ── 2. AI scoring ──────────────────────────────────────────────────────────
  let scored;
  try {
    scored = await scoreArticles(articles);
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
    process.exit(0);
  }

  const winner = passing.reduce((best, curr) => (curr.score > best.score ? curr : best));

  console.log(`[Filter] Winner: "${winner.title}"`);
  console.log(`[Filter] Score:  ${winner.score}`);
  console.log(`[Filter] Reason: ${winner.reasoning}`);
  console.log(`[Filter] Post:   ${winner.social_post_text}`);

  // ── 4. Dispatch to Buffer ──────────────────────────────────────────────────
  const channelIds = BUFFER_CHANNEL_IDS.split(',').map((id) => id.trim()).filter(Boolean);

  for (const channelId of channelIds) {
    try {
      await postToBuffer(channelId, winner.social_post_text);
    } catch (err) {
      console.error(`[Buffer] Error posting to channel ${channelId}: ${err.message}`);
    }
  }

  // ── 5. WhatsApp alert ──────────────────────────────────────────────────────
  await sendWhatsAppAlert(winner.score, winner.title, winner.social_post_text);

  console.log(`[${new Date().toISOString()}] AutoRSS run completed.`);
}

main();
