# AutoRSS — Automated RSS-to-Social Publishing Pipeline

A lightweight, serverless Node.js automation script that runs on a scheduled GitHub Actions workflow. It fetches RSS feed content, scores it with Google Gemini AI, publishes the top-scoring article to social media via Buffer, and delivers a WhatsApp confirmation alert via CallMeBot.

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
   - [Step 5 — WhatsApp Notification via CallMeBot](#step-5--whatsapp-notification-via-callmebot)
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
│                         (every 2 hours)                             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  triggers
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          index.js  (Node 20)                        │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────────────────┐  │
│  │  RSS Parser  │───▶│ Time Filter  │───▶│  Gemini 1.5 Flash AI  │  │
│  │ (multi-feed) │    │  (118 min)   │    │  (score + post text)  │  │
│  └──────────────┘    └──────────────┘    └───────────┬───────────┘  │
│                                                      │              │
│                                          ┌───────────▼───────────┐  │
│                                          │  Threshold Filter     │  │
│                                          │  + Winner Selection   │  │
│                                          └───────────┬───────────┘  │
│                                                      │              │
│                               ┌──────────────────────▼───────────┐  │
│                               │  Buffer GraphQL API              │  │
│                               │  (one mutation per channel ID)   │  │
│                               └──────────────────────┬───────────┘  │
│                                                      │              │
│                                          ┌───────────▼───────────┐  │
│                                          │  CallMeBot WhatsApp   │  │
│                                          │  (GET notification)   │  │
│                                          └───────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

The entire pipeline is **stateless** — it holds no database, no persistent cache, and no inter-run memory. Every execution is self-contained and safe to re-run.

---

## Project Structure

```
AutoRSS/
├── index.js                        # Core automation script (ES Module)
├── package.json                    # Node.js project manifest
└── .github/
    └── workflows/
        └── cron-job.yml            # GitHub Actions scheduled workflow
```

---

## Technology Stack

| Concern | Technology | Reason |
|---|---|---|
| Runtime | Node.js v20+ (ES Modules) | Native `fetch`, top-level `await` support, LTS stability |
| RSS Parsing | `rss-parser` npm package | Handles RSS 2.0 and Atom feeds, normalises field names |
| AI Scoring | `@google/generative-ai` → `gemini-1.5-flash` | Fast inference, enforced JSON output via `responseMimeType` |
| Social Posting | Native `fetch` → Buffer GraphQL API | No extra SDK needed; GraphQL mutations give precise control |
| Notifications | Native `fetch` → CallMeBot REST API | Free WhatsApp alerting via a simple GET request |
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
After all feeds are fetched and their items concatenated into a single flat array, each item is evaluated against a 118-minute (1 hour 58 minutes) maximum age window:

```
cutoff = Date.now() - (118 * 60 * 1000)
keep item if: new Date(item.isoDate ?? item.pubDate).getTime() >= cutoff
```

The script prefers `isoDate` over `pubDate` because `isoDate` is already normalised to ISO 8601 by `rss-parser` and parses reliably. Items with no parseable date field are **discarded silently**.

The 118-minute window is intentionally 2 minutes shorter than the 2-hour cron interval. This small buffer guards against edge cases where GitHub Actions delays the run slightly past the scheduled time — ensuring a fresh article published just before the previous run is not accidentally re-picked by a late-firing subsequent run.

If the filtered array is empty after this pass, the script logs a message and calls `process.exit(0)` — a clean exit that GitHub Actions records as a success, not a failure.

---

### Step 2 — AI Scoring via Google Gemini

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
| `title` | string | The original article title, echoed back |
| `score` | integer | 0–100 relevance and quality score |
| `reasoning` | string | One sentence explaining the score |
| `social_post_text` | string | Ready-to-publish post, under 280 characters |

The `social_post_text` character limit is enforced by instruction in the prompt. Gemini generally respects this constraint, though the downstream WhatsApp notification would still work if a post were slightly over.

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

**File location:** `index.js` → `postToBuffer(channelId, text)`

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
    "text": "<generated social_post_text>",
    "channelId": "<current channel ID>",
    "schedulingType": "automatic",
    "mode": "addToQueue"
  }
}
```

`schedulingType: "automatic"` and `mode: "addToQueue"` tell Buffer to slot the post into the channel's pre-configured posting schedule rather than publishing it immediately or requiring a specific timestamp.

#### Multi-Channel Loop
`BUFFER_CHANNEL_IDS` is a comma-separated string of Buffer channel IDs. The script iterates through them **sequentially** (not concurrently) with a `for...of` loop. Each iteration is wrapped in `try/catch` so a failure on one channel (e.g. a disconnected Twitter account) does not prevent the post from being sent to the remaining channels.

---

### Step 5 — WhatsApp Notification via CallMeBot

**File location:** `index.js` → `sendWhatsAppAlert(score, title, socialPostText)`

#### CallMeBot API
CallMeBot provides a free WhatsApp messaging API. A pre-activated phone number + API key pair receives messages via a simple HTTP GET request — no server-side WebSocket or webhook setup required.

#### Message Format
The notification message uses WhatsApp's lightweight markdown dialect. Asterisks (`*text*`) render as **bold** in WhatsApp:

```
✅ *Automated Post Queued!*

*AI Score:* 87
*Source Article:* Why Serverless Is Still Winning in 2026

*Generated Post:*
Serverless adoption hits 68% of new workloads in 2026...
```

#### URL Encoding
The entire message string is passed through `encodeURIComponent()` before being embedded in the query string. This correctly escapes newlines (`%0A`), asterisks, spaces, and any special characters that would otherwise break the URL or be misinterpreted by the server.

#### Non-Fatal Design
The entire function body is wrapped in `try/catch`. If the GET request throws (network timeout, DNS failure) or returns a non-200 status, the error is logged as a **warning** and execution continues. The GitHub Actions run does not fail because of a notification hiccup — the social posts have already been queued at this point.

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
| `BUFFER_CHANNEL_IDS` | Yes | Comma-separated strings | Buffer channel IDs for the target social accounts. Find these via `GET /channels` or Buffer's web UI. |
| `CALLMEBOT_PHONE` | Yes | String | WhatsApp-registered phone number with country code, no `+` prefix (e.g. `447911123456`) |
| `CALLMEBOT_API_KEY` | Yes | String | CallMeBot API key received after activating your number |

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
  schedule:
    - cron: '0 */2 * * *'
  workflow_dispatch:
```

- `schedule` runs the job at minute 0 of every even-numbered UTC hour: 00:00, 02:00, 04:00, …, 22:00.
- `workflow_dispatch` adds a "Run workflow" button in the GitHub Actions UI, allowing manual one-off executions without pushing a commit.

> **Important:** GitHub does not guarantee cron jobs fire at the exact scheduled second. Under high load, runs can be delayed by several minutes. The 118-minute filter window accounts for this with a 2-minute buffer.

### Job Configuration
```yaml
jobs:
  run-autorss:
    runs-on: ubuntu-latest
    timeout-minutes: 10
```

- `ubuntu-latest` provides a clean Node.js-compatible Linux environment.
- `timeout-minutes: 10` is a hard ceiling. If any API call hangs indefinitely (e.g. a Gemini timeout with no response), the job is killed at 10 minutes rather than consuming Actions minutes until the 6-hour GitHub maximum.

### Step Breakdown

| Step | Action | What it does |
|---|---|---|
| Checkout | `actions/checkout@v4` | Clones the repo so `index.js` and `package.json` are available |
| Setup Node | `actions/setup-node@v4` with `node-version: '20'` and `cache: 'npm'` | Installs Node 20, caches the npm dependency cache between runs |
| Install deps | `npm ci` | Installs exact versions from `package-lock.json` — reproducible and faster than `npm install` |
| Run script | `node index.js` | Executes the pipeline; any non-zero exit code fails the workflow run |

### Secret Injection
```yaml
env:
  RSS_FEEDS:          ${{ secrets.RSS_FEEDS }}
  GEMINI_API_KEY:     ${{ secrets.GEMINI_API_KEY }}
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
| No recent articles | All articles older than 118 min | Exits with code 0 — expected quiet run |
| Gemini API | Network error, malformed JSON response | Exits with code 1 — workflow run marked as failed; prompts investigation |
| No articles pass threshold | All scores below threshold | Exits with code 0 — expected run, not an error |
| Buffer API (single channel) | GraphQL error, MutationError, network error | Logs error, continues to next channel ID |
| Buffer API (all channels) | All channel posts fail | Script reaches WhatsApp step and exits cleanly — posts are lost but run is not failed |
| WhatsApp notification | Any failure | Logged as warning only; never causes non-zero exit |

The philosophy is: **posting failures are soft failures; data-pipeline failures are hard failures**. A broken notification API should never mask the fact that posts were queued successfully.

---

## Setup & Deployment Guide

### Prerequisites
- A GitHub account with a repository for this project
- A Google AI Studio account with an API key ([aistudio.google.com](https://aistudio.google.com))
- A Buffer account with at least one connected social channel ([buffer.com](https://buffer.com))
- A WhatsApp number activated with CallMeBot ([callmebot.com](https://www.callmebot.com/blog/free-api-whatsapp-messages/))

### Step 1 — Push the code
Push the contents of this directory to your GitHub repository's default branch.

### Step 2 — Find your Buffer Channel IDs
Log in to Buffer. Channel IDs are not shown in the UI directly — use one of these methods:
- Use the Buffer MCP server (if configured) and call `list_channels`
- Make an authenticated GraphQL query:
  ```graphql
  query { channels { id name service } }
  ```
  via `curl` or a GraphQL client to `https://api.buffer.com/graphql` with your Bearer token.

### Step 3 — Activate CallMeBot
Send a WhatsApp message to `+34 644 82 14 30` with the text `I allow callmebot to send me messages`. You will receive an API key in reply within a few minutes.

### Step 4 — Add GitHub Repository Secrets
Navigate to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Add all eight secrets listed in the [Environment Variables Reference](#environment-variables-reference) table.

### Step 5 — Enable GitHub Actions
If Actions is not already enabled on the repository, go to the **Actions** tab and click the enable button.

The workflow will fire automatically at the next scheduled time. To test immediately, go to **Actions** → **AutoRSS Feed Processor** → **Run workflow**.

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
$env:CALLMEBOT_PHONE = "447911123456"
$env:CALLMEBOT_API_KEY = "your-callmebot-key"
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
To test without actually posting to Buffer or sending a WhatsApp message, temporarily comment out the calls to `postToBuffer` and `sendWhatsAppAlert` in `main()` and log the `winner` object instead. All upstream steps (RSS fetch, Gemini scoring, threshold filtering) will execute normally.

---

## Limitations & Known Behaviours

- **GitHub Actions cron is UTC.** The `0 */2 * * *` schedule fires at UTC midnight, 02:00 UTC, 04:00 UTC, etc. If your audience is in a specific timezone, adjust the cron expression accordingly.

- **GitHub Actions cron is not guaranteed to fire on time.** Under heavy platform load, runs may be delayed by several minutes. The 118-minute filter window provides a 2-minute buffer but cannot account for delays longer than that.

- **GitHub Actions disables scheduled workflows on inactive repositories.** If no commits are pushed to the repository for 60 days, GitHub pauses cron triggers. Keep the repo active or use `workflow_dispatch` periodically.

- **One post per run, not per matching article.** Even if five articles pass the scoring threshold, only the single highest-scoring article is published. This is by design to avoid flooding social channels.

- **No deduplication between runs.** If the same article appears in the RSS feed across two consecutive runs (i.e. it was published close to the hour boundary and is still within the 118-minute window on the next run), it could be posted twice. To prevent this, consider maintaining a small seen-IDs log in a GitHub Actions cache or a free key-value store.

- **Gemini `social_post_text` character count is advisory.** The model is instructed to stay under 280 characters but this is not mechanically enforced. If a generated post is over the limit, Twitter may truncate it silently while Threads may accept it (Threads supports up to 500 characters).

- **Buffer's `addToQueue` mode requires a posting schedule.** If the target Buffer channel has no time slots configured in its posting schedule, Buffer may hold the post indefinitely rather than publishing it. Configure at least one daily time slot per channel in the Buffer dashboard.
