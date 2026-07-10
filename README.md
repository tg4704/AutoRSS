# AutoRSS — Automated RSS-to-Social Publishing Pipeline

A lightweight, serverless Node.js automation script that runs on a scheduled GitHub Actions workflow. It fetches RSS feed content, scores it with Google Gemini AI, writes **platform-specific** posts for the top-scoring article, publishes the **main post** to each connected platform via Buffer, and delivers a Telegram digest containing the article's hero image (or an AI image-generation prompt) plus any **reply/thread follow-ups for you to post manually**.

**Cadence:** the brand posts **twice a day — 11:00 & 17:00 IST (05:30 & 11:30 UTC)**. The main post always stands on its own, so skipping the manual replies loses nothing essential.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Technology Stack](#technology-stack)
4. [System Execution Flow](#system-execution-flow)
   - [Step 1 — RSS Ingestion & Time Filtering](#step-1--rss-ingestion--time-filtering)
   - [Step 2 — AI Scoring via Google Gemini](#step-2--ai-scoring-via-google-gemini)
   - [Step 3 — Threshold Filtering & Winner Selection](#step-3--threshold-filtering--winner-selection)
   - [Step 4 — Buffer GraphQL Post Dispatch](#step-4--buffer-graphql-post-dispatch)
   - [Step 5 — Telegram Notification](#step-5--telegram-notification)
5. [Environment Variables Reference](#environment-variables-reference)
6. [GitHub Actions Workflow](#github-actions-workflow)
7. [Error Handling Strategy](#error-handling-strategy)
8. [Setup & Deployment Guide](#setup--deployment-guide)
9. [Local Development & Testing](#local-development--testing)
10. [Limitations & Known Behaviours](#limitations--known-behaviours)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GitHub Actions Cron                          │
│              (twice a day — 05:30 & 11:30 UTC)                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  triggers
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          index.js  (Node 24)                        │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌─────────────┐  │
│  │  RSS Parser  │─▶│ Time Filter  │─▶│  Dedup   │─▶│  Gemini     │  │
│  │ (multi-feed) │  │  (20 hours)  │  │(posted   │  │  SCORE call │  │
│  └──────────────┘  └──────────────┘  │ .json)   │  │ (all items) │  │
│                                       └──────────┘  └──────┬──────┘  │
│                                                            │         │
│                                          ┌─────────────────▼──────┐  │
│                                          │  Threshold Filter      │  │
│                                          │  + Winner Selection    │  │
│                                          └───────────┬────────────┘  │
│                                                      │              │
│                          ┌───────────────────────────▼────────────┐ │
│                          │  Gemini WRITE call (winner only)        │ │
│                          │  → per-platform main post + replies     │ │
│                          │  Buffer service lookup → platform map    │ │
│                          │  Code places source links per platform  │ │
│                          └───────────────────────────┬────────────┘ │
│                                                      │              │
│                               ┌──────────────────────▼───────────┐  │
│                               │  Buffer GraphQL API (shareNow)   │  │
│                               │  (main post → each platform)     │  │
│                               └──────────────────────┬───────────┘  │
│                                                      │              │
│                       ┌──────────────────────────────▼───────────┐  │
│                       │  Record key → posted.json (commit back)  │  │
│                       └──────────────────────────────┬───────────┘  │
│                                                      │              │
│                               ┌──────────────────────▼───────────┐  │
│                               │  Telegram: hero image (or gen    │  │
│                               │  prompt) + per-platform digest   │  │
│                               │  with replies to post manually   │  │
│                               └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

The pipeline is **near-stateless** — the only persisted state is `posted.json`, a small deduplication log committed back to the repo after each successful post. There is no database or external cache; every execution is otherwise self-contained and safe to re-run.

---

## Project Structure

```
AutoRSS/
├── index.js                        # Core automation script (ES Module)
├── package.json                    # Node.js project manifest
├── posted.json                     # Dedup history — keys of already-posted articles
└── .github/
    └── workflows/
        └── cron-job.yml            # GitHub Actions scheduled workflow
```

> `posted.json` is committed back to the repo automatically by the workflow after each successful post. It starts as an empty array `[]` and grows to a rolling window of the most recent 500 posted-article keys.

---

## Technology Stack

| Concern | Technology | Reason |
|---|---|---|
| Runtime | Node.js v24 (ES Modules) | Native `fetch`, top-level `await` support, current runner default |
| RSS Parsing | `rss-parser` npm package | Handles RSS 2.0 and Atom feeds, normalises field names |
| AI Scoring | `@google/generative-ai` → `gemini-3.5-flash` | Fast inference, enforced JSON output via `responseMimeType` |
| Social Posting | Native `fetch` → Buffer GraphQL API | No extra SDK needed; GraphQL mutations give precise control |
| Notifications | Native `fetch` → Telegram Bot API | Free, reliable alerting via a simple POST request |
| Deduplication | `posted.json` committed back to the repo | Self-contained, no external store needed |
| Scheduling | GitHub Actions cron | Serverless, free for public repos, no infrastructure to manage |
| Secret Storage | GitHub Repository Secrets | Encrypted at rest, injected as environment variables at runtime |

---

## System Execution Flow

### Step 1 — RSS Ingestion & Time Filtering

**File location:** `index.js` → `fetchAndFilterArticles()`

#### Feed URL Parsing
The `RSS_FEEDS` environment variable is expected to be a comma-separated string of fully-qualified RSS/Atom feed URLs:
```
https://feeds.example.com/rss,https://otherblog.com/feed,https://news.site.com/atom.xml
```
The script splits on `,`, trims whitespace from each token, and discards any empty strings that result from trailing commas.

#### Concurrent Fetching
All feed URLs are requested **in parallel** using `Promise.all()`. Each URL is wrapped in its own inner `try/catch` so that a single unreachable feed does not abort the others — it logs an error and returns an empty array for that feed slot instead.

Under the hood, `rss-parser` makes an HTTP GET request to each URL, parses the XML response body, and normalises the result into a consistent JavaScript object regardless of whether the feed is RSS 2.0, RSS 1.0, or Atom format. The relevant normalised fields used downstream are:

| `rss-parser` field | Source in RSS 2.0 | Source in Atom |
|---|---|---|
| `item.title` | `<title>` | `<title>` |
| `item.contentSnippet` | Plain-text stripped from `<description>` | Plain-text stripped from `<summary>` |
| `item.link` | `<link>` | `<link href="...">` |
| `item.isoDate` | Parsed from `<pubDate>`, converted to ISO 8601 | Parsed from `<updated>` or `<published>` |
| `item.pubDate` | Raw `<pubDate>` string | — |

#### Time Window Filtering
After all feeds are fetched and their items concatenated into a single flat array, each item is evaluated against a **20-hour** maximum age window (`MAX_AGE_MS`):

```
cutoff = Date.now() - (20 * 60 * 60 * 1000)
keep item if: new Date(item.isoDate ?? item.pubDate).getTime() >= cutoff
```

The script prefers `isoDate` over `pubDate` because `isoDate` is already normalised to ISO 8601 by `rss-parser` and parses reliably. Items with no parseable date field are **discarded silently**.

The 20-hour window must span the **longest gap between the two daily runs** (17:00 → 11:00 IST = 18 hours), or the morning run would miss everything published overnight. The extra ~2 hours is margin for a delayed or missed trigger. Duplicate posting is prevented by the deduplication layer (`posted.json`), not by the time window, so a wide window carries no risk of reposts — re-surfacing already-seen articles simply keeps strong runners-up eligible for the next slot (only the single winner is recorded as posted each run).

If the filtered array is empty after this pass, the script logs a message and calls `process.exit(0)` — a clean exit that GitHub Actions records as a success, not a failure.

---

### Step 2 — AI Scoring via Google Gemini

> **Two Gemini calls per run.** Scoring and post-writing are now **separate** calls.
> Call 1 (`scoreArticles`) scores every article. Call 2 (`writePlatformPosts`) writes
> platform-specific content for the **single winner only** — so the model never wastes work
> writing posts for articles that won't be published. If nothing passes the threshold, only
> Call 1 runs.

**File location:** `index.js` → `scoreArticles()`

#### Payload Construction
The filtered article objects are serialised into a plain-text block — one delimited section per article:

```
--- Article 1 ---
Title:   Why Serverless Is Still Winning in 2026
Snippet: The latest State of Cloud report shows that 68% of new workloads...
Link:    https://example.com/serverless-2026

--- Article 2 ---
...
```

`contentSnippet` is truncated to 400 characters before embedding. This serves two purposes:
1. Keeps the total prompt token count predictable and bounded.
2. Prevents abnormally long article descriptions from drowning the signal of shorter ones.

#### Model Configuration
The Gemini client is initialised with `responseMimeType: "application/json"` in `generationConfig`. This instructs the model to constrain its entire output to valid JSON — it will not produce preamble text, markdown code fences, or trailing commentary. This makes `JSON.parse()` on the raw response reliable without any pre-processing.

#### System Prompt Design
The prompt has two logical sections:

1. **Persona + evaluation criteria** — instructs the model to act as a social media curator for the user's specific niche (injected from `SCORING_CRITERIA`), and to score each article on a 0–100 integer scale based on relevance, viral potential, and audience value.

2. **Output schema enforcement** — provides the exact JSON array schema the model must conform to, including field names and types. This schema-in-prompt approach combined with `responseMimeType` is more reliable than post-processing free-form text.

Each article in the output array contains:

| Field | Type | Description |
|---|---|---|
| `id` | integer | The article's index in the batch, echoed back so the winner can be mapped to its original feed item (to recover the source link and dedup key) |
| `title` | string | The original article title, echoed back (fallback lookup key) |
| `score` | integer | 0–100 relevance and quality score |
| `reasoning` | string | One sentence explaining the score |

Scoring no longer writes any post text — that happens in Step 3b for the winner only.

---

### Step 2b — Per-Platform Post Writing (winner only)

**File location:** `index.js` → `writePlatformPosts()` / `buildWriterPrompt()`

Once the winner is chosen, a **second Gemini call** writes distinct content for each platform. Key rules baked into the prompt:

- **One angle only** (a number that contradicts an assumption / an unresolved question / a scale comparison) — no full-article summaries.
- **Banned hooks**: `Imagine…`, `We always assumed…`, `What if…`, and dead-end rhetorical questions.
- Kept from the old prompt: **zero em dashes**, no headline restatement, plain language, no hashtags, no `Breaking:`/`Wow!` filler.
- **Per-platform limits**: Threads ≤500, X ≤280, Bluesky ≤300 (native thread preferred).
- **The model emits NO URLs** — link placement is owned by code (see Step 4) to avoid URL hallucination.
- Every platform's **main post must read as complete on its own**, because replies are optional and posted manually.

Output (strict JSON) contains `angle_chosen`, `image_description` (an AI image-generation prompt used as a fallback), and a `platforms` object keyed only by the configured platforms, each with `main_post` and a `replies` array.

---

### Step 3 — Threshold Filtering & Winner Selection

**File location:** `index.js` → `main()` inline logic

The parsed array from Gemini is filtered with a simple numeric comparison:

```js
const passing = scored.filter((a) => a.score >= POSTING_THRESHOLD);
```

`POSTING_THRESHOLD` defaults to `80` if the environment variable is not set or is not numeric. This default is intentionally conservative — it ensures only high-confidence articles get published.

If `passing` is empty, the script logs the highest score seen across all evaluated articles (useful for tuning the threshold) and exits cleanly with code `0`.

From the passing subset, the winner is selected with a single `reduce` pass — O(n) and deterministic:

```js
const winner = passing.reduce((best, curr) => curr.score > best.score ? curr : best);
```

In the case of a tie (two articles share the identical top score), the first one encountered in the array wins. Since the array order reflects RSS feed order (and therefore reverse-chronological publication order within each feed), this means the most-recently-published article wins ties.

---

### Step 4 — Buffer GraphQL Post Dispatch

**File location:** `index.js` → `resolvePlatformChannels()`, `applyLinks()`, `postToBuffer(channelId, text)`

#### Channel → platform auto-detection
`BUFFER_CHANNEL_IDS` stays a bare comma-separated list — **no labeling needed**. At runtime the script queries Buffer (`account { organizations }` then `channels(input) { id name service }`) and maps each channel's `service` onto a platform key: `twitter`/`x` → `x`, `threads` → `threads`, `bluesky` → `bluesky`. Only detected, supported platforms are written for and posted to; unsupported services are skipped with a warning. This is how the script knows which platform-specific post goes to which channel.

#### Link placement + limit enforcement (code owns URLs)
The writer model never emits URLs. `applyLinks()` places the source link per platform and **hard-enforces each platform's character limit** (LLMs can't count reliably and Buffer rejects over-limit posts), trimming at a word boundary via `clip()`:

- **Every main post stays link-free** (links suppress reach) — the source link goes in a **reply you post manually**.
- **threads / x** — clean main post; the link rides in the first **reply**. If the model produced no reply, the link becomes the reply on its own.
- **bluesky** — clean main post; the link is appended to the **last thread post** (or its single link reply).
- **JC articles** — no link anywhere (they carry no shareable source), preserving prior behavior.

The main post sent to Buffer is always within limits (Threads 500, X 280, Bluesky 300, minus a small margin); manually-posted replies are trimmed too so they stay postable.

#### Why GraphQL
Buffer's primary public API is GraphQL. Using native `fetch` with a raw GraphQL mutation avoids taking a dependency on Buffer's own SDK and keeps the implementation transparent and auditable.

#### Authentication
Every request carries an `Authorization: Bearer <BUFFER_API_KEY>` header. The API key is a personal access token generated in Buffer's account settings.

#### The Mutation
```graphql
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    ... on PostActionSuccess {
      post { id }
    }
    ... on MutationError {
      message
    }
  }
}
```

The `createPost` return type is a **GraphQL union** — it resolves to either `PostActionSuccess` (the post was accepted) or `MutationError` (Buffer rejected the request). The script uses inline fragments (`... on`) to handle both branches:

- If `outcome.post.id` is present → success, logs the returned post ID
- If `outcome.message` is present → Buffer returned a domain-level error (e.g. channel disconnected, content policy violation); the message is logged to stderr
- If neither is present → unexpected response shape; logged as a warning

#### Variables Payload
```json
{
  "input": {
    "text": "<platform-specific main post (link applied per Step 4 rules)>",
    "channelId": "<the channel resolved for this platform>",
    "schedulingType": "automatic",
    "mode": "shareNow"
  }
}
```

`mode: "shareNow"` tells Buffer to publish the post immediately rather than slotting it into the channel's posting schedule. The valid `ShareMode` enum values (from the Buffer schema) are: `shareNow` (publish now), `addToQueue` (next open queue slot), `shareNext` (front of queue), `customScheduled` (a specific `dueAt`), and `recommendedTime` (Buffer's suggested time). Only the **main post** is dispatched — reply/thread follow-ups are never auto-posted; they are delivered via Telegram for you to post manually.

#### Per-Platform Loop
The script loops over the resolved `{ platform: channelId }` map and posts each platform's **own** main post to its channel. Each iteration is wrapped in `try/catch` so a failure on one channel (e.g. a disconnected account) does not prevent the others. The dedup key is recorded only after at least one channel accepts.

---

### Step 5 — Telegram Digest (hero image + per-platform posts + manual replies)

**File location:** `index.js` → `scrapeHeroImage()`, `sendTelegramPhoto()`, `sendTelegramDigest()`

#### Telegram Bot API
A Telegram bot (created via `@BotFather`) sends messages/photos to a chat via a single authenticated HTTP `POST` to `https://api.telegram.org/bot<token>/{sendMessage,sendPhoto}`. No phone activation, webhooks, or polling required — just a bot token and the target chat ID.

#### Hero image
Before the digest, the script fetches the winning article's page and extracts its `og:image` (fallback `twitter:image`). If found, it is sent as a photo via `sendPhoto` so you can attach it to your posts. If no hero image exists, the digest instead includes the `image_description` — an AI image-generation prompt — so you can generate one. (JC articles carry no source URL, so no scrape is attempted.)

#### Message Format
The digest uses Telegram's **MarkdownV2** dialect (`parse_mode: "MarkdownV2"`). It shows the score, source, the chosen angle, and — per platform — step-by-step instructions: the **main post already published** and exactly what to **reply with manually** (the source link lives in that reply):

```
✅ Automated Post Published!

🕐 Run Time: Tue, 03 Jun 2026 08:00:12 GMT
AI Score: 91
Source Article: Why Serverless Is Still Winning in 2026
🎯 Angle: A cold number that contradicts assumption
🔗 Source: https://example.com/serverless-2026

📋 How to finish up: each main post below is already live. Reply to it
manually with the line(s) shown to add the source link / continue the thread.

━━━ THREADS ━━━
✅ Main post (already published):
<clean main post>

👉 Your turn: reply to that post with this to add the source link:
  1. Full breakdown here:
     https://example.com/serverless-2026

━━━ X ━━━
✅ Main post (already published):
<clean main tweet>

👉 Your turn: reply to that post with this to add the source link:
  1. Source and the full numbers:
     https://example.com/serverless-2026

━━━ BLUESKY ━━━
✅ Main post (already published):
<clean main post>

👉 Your turn: reply to that post, then keep the thread going with these, in order:
  1. <continuation post, link on the last one>

🖼 Hero image sent above — attach it when you post the reply, or repost the main with it.
```

#### MarkdownV2 Escaping
MarkdownV2 reserves many characters (`_ * [ ] ( ) ~ \` > # + = | { } . ! -`). Any of these appearing in the article title or post body would otherwise break parsing, so they are escaped with a leading backslash via a small `escapeMd()` helper before the message is assembled. Telegram renders the escaped text correctly (the backslashes are not displayed).

#### Non-Fatal Design
The entire function body is wrapped in `try/catch`. If the request throws (network timeout, DNS failure) or Telegram returns `{ ok: false }`, the error is logged as a **warning** and execution continues. The GitHub Actions run does not fail because of a notification hiccup — the social posts have already been published at this point.

---

## Environment Variables Reference

All variables are read from `process.env` at runtime. In GitHub Actions they are injected from Repository Secrets. For local testing, set them in your shell or use a `.env` file with a loader (see [Local Development](#local-development--testing)).

| Variable | Required | Type | Description |
|---|---|---|---|
| `RSS_FEEDS` | Yes | Comma-separated URLs | One or more RSS/Atom feed URLs to monitor |
| `GEMINI_API_KEY` | Yes | String | Google AI Studio API key for Gemini access |
| `SCORING_CRITERIA` | Yes | Free text | Natural-language description of your niche and what makes a post worth sharing. This is injected verbatim into the AI system prompt. The more specific, the better the scores. |
| `POSTING_THRESHOLD` | Yes | Integer 0–100 | Minimum score an article must achieve to be published. Recommended starting point: `75`–`85`. |
| `BUFFER_API_KEY` | Yes | String | Buffer personal access token from Buffer → Settings → API |
| `BUFFER_CHANNEL_IDS` | Yes | Comma-separated strings | Buffer channel IDs for the target social accounts (Threads / X / Bluesky). Find these via the `channels` GraphQL query or Buffer's web UI. **No labeling needed** — the script auto-detects each channel's platform from Buffer's `service` field. |
| `TELEGRAM_BOT_TOKEN` | Yes | String | Bot token from `@BotFather` (format: `123456789:ABCdef...`) |
| `TELEGRAM_CHAT_ID` | Yes | String | Your chat ID from `@userinfobot` (format: `123456789`) |

### Example `SCORING_CRITERIA` values

**For a developer tools newsletter:**
```
We cover developer productivity tools, AI coding assistants, and software engineering best practices.
Our audience is senior software engineers and CTOs. Prioritise articles about new tool releases,
benchmark comparisons, and productivity studies. Score down opinion pieces with no data.
```

**For a crypto/Web3 account:**
```
We cover DeFi protocols, Layer 2 scaling solutions, and NFT market trends.
Our audience is crypto-native investors and builders. Score highly for breaking news,
major protocol upgrades, and significant on-chain data findings. Score down price speculation.
```

---

## GitHub Actions Workflow

**File:** `.github/workflows/cron-job.yml`

### Trigger Configuration
```yaml
on:
  workflow_dispatch:   # Triggered externally by cron-job.org twice a day (05:30 & 11:30 UTC)
```

The workflow is triggered exclusively via `workflow_dispatch` — a GitHub API event fired by an external scheduler (cron-job.org) **twice a day, at 05:30 & 11:30 UTC (11:00 & 17:00 IST)**. This replaces GitHub's built-in `schedule` trigger, which is unreliable on the free tier (runs are often delayed 5–30 minutes or skipped entirely under platform load).

GitHub's built-in `schedule` was removed because:
1. It fires at peak load times (top-of-the-hour) causing delays and outright skips
2. Skipped runs meant articles in that gap were permanently missed
3. There is no retry mechanism — GitHub simply drops the missed run

The external dispatcher (`cron-job.org`) fires within seconds of the scheduled time, every time, and provides a per-execution history log with HTTP response codes so you can confirm each trigger landed.

> **Note:** `workflow_dispatch` also adds a **"Run workflow"** button in the GitHub Actions UI for manual one-off executions without pushing a commit.

### External Scheduler Setup (cron-job.org)

1. Create a free account at [cron-job.org](https://cron-job.org)
2. Create a GitHub **Fine-grained Personal Access Token** at `github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens`:
   - Repository access: `AutoRSS` only
   - Permissions → Actions: `Read and Write`
3. In cron-job.org, create a new cron job with these settings:

| Field | Value |
|---|---|
| URL | `https://api.github.com/repos/YOUR_USERNAME/AutoRSS/actions/workflows/cron-job.yml/dispatches` |
| Method | `POST` |
| Schedule | Twice daily at **05:30 and 11:30 UTC** (cron: `30 5,11 * * *`) |
| Header 1 | `Authorization: Bearer YOUR_PAT_TOKEN` |
| Header 2 | `Content-Type: application/json` |
| Request body | `{"ref":"main"}` |

4. Save — cron-job.org will POST to GitHub at 05:30 and 11:30 UTC; GitHub fires `workflow_dispatch` and the run starts within seconds.

**Verify it works:** After the first trigger, you should see a `204 No Content` response in cron-job.org's History tab and a new run appear in GitHub Actions almost immediately. You can also test it manually from PowerShell:
```powershell
$headers = @{
  "Authorization" = "Bearer YOUR_PAT_TOKEN"
  "Accept"        = "application/vnd.github+json"
  "Content-Type"  = "application/json"
}
Invoke-RestMethod -Method Post `
  -Uri "https://api.github.com/repos/YOUR_USERNAME/AutoRSS/actions/workflows/cron-job.yml/dispatches" `
  -Headers $headers `
  -Body '{"ref":"main"}'
```
No output = success (`204`). A new run appears in Actions within seconds.

> **Important:** Do not test this URL by visiting it in a browser — browsers send GET requests (unauthenticated), which always return `404 Not Found`. The endpoint only accepts authenticated POST requests.

### Job Configuration
```yaml
jobs:
  run-autorss:
    runs-on: ubuntu-latest
    timeout-minutes: 35
```

- `ubuntu-latest` provides a clean Node.js-compatible Linux environment.
- `timeout-minutes: 35` is a hard ceiling sized for the built-in retry loop (below). A normal run finishes in ~1–2 minutes; the extra headroom covers up to two 10-minute waits between retries.

#### Built-in 10-minute retry
The run step reruns `node index.js` **up to 3 times, waiting 10 minutes between attempts**, so a transient outage (e.g. Gemini API down → nothing posted) recovers on its own without a human re-trigger:

```yaml
run: |
  for attempt in 1 2 3; do
    if node index.js; then exit 0; fi
    if [ "$attempt" -lt 3 ]; then sleep 600; fi
  done
  exit 1
```

A successful run exits on the first attempt and never sleeps. Because `posted.json` is written to disk mid-run and re-read at the start of each attempt, an already-posted article is deduped out — so a retry only re-posts when the earlier attempt posted **nothing**.

### Step Breakdown

| Step | Action | What it does |
|---|---|---|
| Checkout | `actions/checkout@v4` | Clones the repo so `index.js`, `package.json`, and `posted.json` are available |
| Setup Node | `actions/setup-node@v4` with `node-version: '24'` and `cache: 'npm'` | Installs Node 24, caches the npm dependency cache between runs |
| Install deps | `npm ci` | Installs exact versions from `package-lock.json` — reproducible and faster than `npm install` |
| Run script | retry loop around `node index.js` | Executes the pipeline; retries after 10 min on failure (3 attempts). A final failure fails the run |
| Persist history | `if: always()` git commit | Commits the updated `posted.json` back to the repo (only if it changed) |
| Notify on failure | `if: failure()` curl | Sends a Telegram message with a link to the failed run's logs |

The job also declares `permissions: contents: write` (so it can push `posted.json`) and a top-level `concurrency` group (so two runs never overlap and race the commit-back).

### Secret Injection
```yaml
env:
  RSS_FEEDS:           ${{ secrets.RSS_FEEDS }}
  GEMINI_API_KEY:      ${{ secrets.GEMINI_API_KEY }}
  TELEGRAM_BOT_TOKEN:  ${{ secrets.TELEGRAM_BOT_TOKEN }}
  ...
```

GitHub Secrets are encrypted at rest and masked in logs (any accidental `console.log` of a secret value will appear as `***` in the Actions log). They are never exposed in the repository source code.

---

## Error Handling Strategy

The script uses a layered error model:

| Layer | Failure Mode | Behaviour |
|---|---|---|
| Individual RSS feed | Network error, malformed XML | Logs error, skips that feed, continues with others |
| All RSS feeds | Every feed returns empty or fails | Exits with code 0 after logging — not a workflow failure |
| No recent articles | All articles older than the 20-hour window | Exits with code 0 — expected quiet run |
| Gemini API | Network error, malformed JSON response | Exits with code 1 — workflow run marked as failed; prompts investigation |
| No articles pass threshold | All scores below threshold | Exits with code 0 — expected run, not an error |
| Buffer API (single channel) | GraphQL error, MutationError, network error | Logs error, continues to next channel ID |
| Buffer API (all channels) | All channel posts fail | Article is **not** recorded in `posted.json` (so it can be retried next run); proceeds to notification and exits cleanly |
| Dedup write | `posted.json` write fails | Logged as warning only; never causes non-zero exit |
| Telegram notification | Any failure (network, `ok: false`) | Logged as warning only; never causes non-zero exit |

The philosophy is: **posting failures are soft failures; data-pipeline failures are hard failures**. A broken notification API should never mask the fact that posts were published successfully. Note that the dedup key is recorded **only after** at least one channel accepts the post — a fully failed dispatch leaves the article eligible for retry.

---

## Setup & Deployment Guide

### Prerequisites
- A GitHub account with a repository for this project
- A Google AI Studio account with an API key ([aistudio.google.com](https://aistudio.google.com))
- A Buffer account with at least one connected social channel ([buffer.com](https://buffer.com))
- A Telegram account and a bot created via [@BotFather](https://t.me/BotFather)

### Step 1 — Push the code
Push the contents of this directory to your GitHub repository's default branch.

### Step 2 — Find your Buffer Channel IDs
Channel IDs are not shown in the Buffer UI directly. First get your organization ID, then query channels (the `channels` query **requires** an `organizationId` input):
```graphql
# 1. Get your organization ID
{ account { organizations { id name } } }

# 2. List channels for that org
{ channels(input: { organizationId: "YOUR_ORG_ID" }) { id name service } }
```
Send these as authenticated POST requests to `https://api.buffer.com/graphql` with an `Authorization: Bearer <BUFFER_API_KEY>` header. Note that org and channel IDs are **strings** in GraphQL — wrap them in quotes.

### Step 3 — Set up your Telegram bot
1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the **bot token**.
2. Message [@userinfobot](https://t.me/userinfobot) to get your **chat ID**.
3. Send your new bot any message first — a bot cannot initiate a conversation, so it needs an existing chat to reply into.

### Step 4 — Add GitHub Repository Secrets
Navigate to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Add all eight secrets listed in the [Environment Variables Reference](#environment-variables-reference) table.

### Step 5 — Set up cron-job.org as the external scheduler
Follow the [External Scheduler Setup](#external-scheduler-setup-cron-joborg) instructions above to configure cron-job.org to trigger the workflow twice a day (05:30 & 11:30 UTC).

To test immediately before the first scheduled trigger, go to **Actions** → **AutoRSS Feed Processor** → **Run workflow**.

---

## Local Development & Testing

### Install dependencies
```bash
npm install
```

### Set environment variables (PowerShell)
```powershell
$env:RSS_FEEDS = "https://feeds.example.com/rss"
$env:GEMINI_API_KEY = "your-key-here"
$env:SCORING_CRITERIA = "We cover AI and developer tools for senior engineers."
$env:POSTING_THRESHOLD = "75"
$env:BUFFER_API_KEY = "your-buffer-token"
$env:BUFFER_CHANNEL_IDS = "channel-id-1,channel-id-2"
$env:TELEGRAM_BOT_TOKEN = "123456789:ABCdef..."
$env:TELEGRAM_CHAT_ID = "123456789"
```

### Set environment variables (bash / macOS / Linux)
```bash
export RSS_FEEDS="https://feeds.example.com/rss"
export GEMINI_API_KEY="your-key-here"
# ... etc
```

### Run
```bash
node index.js
```

### Safe dry-run tip
To test without actually posting to Buffer or sending a Telegram message, temporarily stub the calls to `postToBuffer`, `sendTelegramPhoto`, and `sendTelegramDigest` in `main()` (and the `savePostedDB` call) to `console.log` instead. All upstream steps (RSS fetch, dedup, Gemini scoring, threshold filtering, per-platform writing, link placement) will execute normally. The pure helpers (`applyLinks`, `serviceToPlatform`, `buildWriterPrompt`) are exported for unit testing.

---

## Limitations & Known Behaviours

- **Scheduling is driven by cron-job.org, not GitHub's built-in cron.** The workflow uses `workflow_dispatch` only. cron-job.org fires the trigger twice a day (05:30 & 11:30 UTC); if it goes down, no runs fire until it recovers. Monitor cron-job.org's History tab to confirm each trigger lands. The 20-hour fetch window means a single missed trigger is largely self-healing — the next run catches up on the gap without reposting (dedup handles that).

- **GitHub disables `workflow_dispatch` on inactive repositories.** If no commits are pushed and no runs are triggered for 60 days, GitHub may pause the workflow. cron-job.org's regular triggers count as activity and should prevent this.

- **One post per run, not per matching article.** Even if five articles pass the scoring threshold, only the single highest-scoring article is published. This is by design to avoid flooding social channels.

- **Exact-article deduplication is handled; semantic deduplication is not.** Each posted article's `guid`/`link` is recorded in `posted.json` and skipped on future runs, so the *same* article URL is never posted twice. However, if the *same news story* is carried by multiple feeds under different URLs, each is treated as a distinct article and a near-duplicate could still be posted on a later run. Solving that would require semantic similarity comparison, which is intentionally out of scope.

- **Dedup depends on the commit-back landing.** The workflow commits the updated `posted.json` back to the repo after each run. If that push fails (e.g. permissions misconfigured), the next run won't see the latest history and could re-post. The `concurrency` group prevents overlapping runs from racing the push.

- **Per-platform character counts are advisory.** The writer is instructed to stay within each platform's budget (Threads ≤500, X ≤280, Bluesky ≤300) but this is not mechanically enforced. If a generated post is over the limit, the platform may truncate it silently.

- **Replies are delivered, not posted.** Only the main post is auto-published. Reply/thread follow-ups (and the source link, which always lives in a reply) are surfaced in the Telegram digest for you to post manually. The main post always reads as complete on its own, so skipping the replies loses nothing essential — though the source link only reaches your audience once you post the reply.

- **Posts publish immediately (`shareNow`).** When a qualifying article is found, its main post is published right away — at whichever of the two daily slots the cron runs (05:30 & 11:30 UTC = 11:00 & 17:00 IST). If you'd rather have Buffer publish only during configured peak slots, change `mode` to `addToQueue` in `index.js` and set up a posting schedule per channel in the Buffer dashboard.
