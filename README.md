# WoWS Reddit Community Pulse Bot

Automated Reddit data collector and AI-powered community sentiment analyser for the r/WorldOfWarships subreddit. Collects posts and comments, runs daily AI sentiment analysis, answers natural-language questions about community discussions, and exposes all data through a REST API consumed by the dockworks.dev admin panel.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Prerequisites](#prerequisites)
3. [Step 1 — Set Up the VPS](#step-1--set-up-the-vps)
4. [Step 2 — Configure .env](#step-2--configure-env)
5. [Step 3 — Build & First Run](#step-3--build--first-run)
6. [Step 4 — Run with PM2](#step-4--run-with-pm2)
7. [Day-to-Day Operations](#day-to-day-operations)
8. [API Endpoints](#api-endpoints)
9. [File Structure](#file-structure)
10. [Troubleshooting](#troubleshooting)

---

## What It Does

| Feature | Description |
|---|---|
| **Post Collector** | Polls r/WorldOfWarships every 15 minutes (configurable) using the Arctic Shift public archive API. Stores posts and top comments in SQLite. |
| **Stats Collector** | Hourly subreddit stats snapshots (subscriber count, active users). Feeds the Trends charts. |
| **Community Pulse** | Daily AI-generated sentiment report (default 08:00 UTC). Topics, pain points (with recurring detection), positives, minority insight, mood score 1–5, and citations to specific posts/comments. Powered by OpenAI GPT-4o-mini. |
| **Community Chat** | Ask any natural-language question about recent Reddit discussions. Two-pass GPT Q&A: FTS5 keyword search → answer with cited sources. Session context preserved for follow-up questions. |
| **Web Dashboard API** | REST API on port 3002 (Bearer auth). Powers the dockworks.dev Reddit admin panel. |

---

## Prerequisites

- A **VPS** running Linux (Ubuntu 22.04+) — same server as the Discord bot is fine
- An **OpenAI API key** (required for Community Pulse and Community Chat)
- Node.js 20+ and npm installed on the VPS
- PM2 installed globally: `npm install -g pm2`

> **No Reddit API key needed.** Posts and comments are fetched from the [Arctic Shift](https://arctic-shift.photon-reddit.com) public archive, which requires no authentication.

---

## Step 1 — Set Up the VPS

```bash
# SSH into the VPS
ssh root@YOUR_VPS_IP

# Clone the repo
cd /home/kuba/apps
git clone https://github.com/ailingloran/community-pulse wows-reddit
cd wows-reddit

# Install dependencies
npm install
```

---

## Step 2 — Configure .env

Create `.env` in the project root:

```bash
nano /home/kuba/community-pulse/.env
```

```env
# ── Reddit ──────────────────────────────────────────────────────────────────
# Subreddit to monitor (without r/)
REDDIT_SUBREDDIT=WorldOfWarships

# ── OpenAI ───────────────────────────────────────────────────────────────────
OPENAI_API_KEY=sk-...

# Hour (UTC) to run the daily Community Pulse report (default: 8 = 08:00 UTC)
SENTIMENT_HOUR=8

# ── Storage ───────────────────────────────────────────────────────────────────
# Path to the SQLite database file (use a persistent volume if available)
REDDIT_DB_PATH=/mnt/HC_Volume_105012469/reddit.db

# ── Dashboard API ─────────────────────────────────────────────────────────────
# Port the REST API listens on
REDDIT_DASHBOARD_PORT=3002

# Bearer token for the API — must match REDDIT_SECRET in the frontend .env
REDDIT_DASHBOARD_SECRET=your_strong_secret_here

# ── Collection intervals ───────────────────────────────────────────────────────
# How often to poll Reddit for new posts (minutes)
POST_POLL_INTERVAL_MIN=15

# How often to take a subreddit stats snapshot (minutes)
STATS_POLL_INTERVAL_MIN=60
```

---

## Step 3 — Build & First Run

```bash
cd /home/kuba/community-pulse

# Compile TypeScript
npm run build

# Optional: test that the API starts
node dist/index.js
# Ctrl+C to stop
```

---

## Step 4 — Run with PM2

```bash
# Start the bot
pm2 start dist/index.js --name wows-reddit

# Save the process list (survives reboots)
pm2 save

# Generate startup script (copy and run the command it outputs)
pm2 startup

# Verify
pm2 status
pm2 logs community-pulse
```

---

## Day-to-Day Operations

### Deploying code changes

**On your local Windows machine (PowerShell):**

```powershell
cd C:\Users\kuba_\wows-reddit

# Stage and commit
git add -A
git commit -m "feat: description of change"

# Push to GitHub
git push
```

**On the VPS (SSH):**

```bash
cd /home/kuba/community-pulse

# Pull latest code
git pull

# Rebuild and restart
npm run build && pm2 restart community-pulse

# Or step by step:
npm run build
pm2 restart community-pulse
```

### Checking status and logs

```bash
# Live process status
pm2 status

# Follow live logs
pm2 logs community-pulse

# Last 100 lines
pm2 logs community-pulse --lines 100

# Clear log files
pm2 flush community-pulse
```

### Restarting, stopping, reloading

```bash
# Graceful restart
pm2 restart community-pulse

# Stop
pm2 stop community-pulse

# Start again
pm2 start community-pulse
```

### Triggering Community Pulse manually

```bash
# Via the dashboard at https://dockworks.dev/admin/reddit → Overview → Trigger button
# Or via the API:
curl -X POST http://localhost:3002/api/sentiment/trigger \
  -H "Authorization: Bearer YOUR_SECRET"
```

### Inspecting the SQLite database

```bash
sqlite3 /mnt/HC_Volume_105012469/reddit.db

sqlite> SELECT COUNT(*) FROM posts;
sqlite> SELECT COUNT(*) FROM comments;
sqlite> SELECT taken_at, mood, mood_score FROM sentiment_reports ORDER BY taken_at DESC LIMIT 5;
sqlite> SELECT * FROM subreddit_snapshots ORDER BY taken_at DESC LIMIT 5;
sqlite> .quit
```

### Updating environment variables

```bash
nano /home/kuba/community-pulse/.env
# Edit values, save (Ctrl+X, Y, Enter)

# Rebuild and restart to apply
npm run build && pm2 restart community-pulse
```

---

## API Endpoints

All endpoints require `Authorization: Bearer REDDIT_DASHBOARD_SECRET`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/status` | Bot uptime, last collection time, post/comment counts |
| `GET` | `/api/posts?limit=50&offset=0` | Paginated post list |
| `GET` | `/api/posts/between?from=&to=` | Posts in a date range |
| `GET` | `/api/snapshots` | All subreddit stats snapshots |
| `GET` | `/api/snapshots/latest` | Most recent snapshot |
| `GET` | `/api/posts-per-day` | Daily post counts (for trend charts) |
| `GET` | `/api/sentiment?limit=30` | Last N Community Pulse reports |
| `GET` | `/api/sentiment/trend?days=30` | Mood score history for the trend chart |
| `POST` | `/api/sentiment/trigger` | Trigger a Community Pulse run immediately |
| `POST` | `/api/chat` | Submit a Community Chat question (returns `jobId`) |
| `GET` | `/api/chat/:jobId` | Poll a chat job for its result |
| `GET` | `/api/chat/history` | Past Community Chat answers |
| `DELETE` | `/api/chat/:jobId` | Remove a completed job |

---

## File Structure

```
wows-reddit/
├── src/
│   ├── index.ts                   # Entry point — starts scheduler and API server
│   ├── config.ts                  # Environment variable config
│   ├── logger.ts                  # Pino logger
│   ├── scheduler.ts               # node-cron jobs (collection + sentiment)
│   ├── api/
│   │   ├── reddit.ts              # Arctic Shift API client
│   │   └── openai.ts              # OpenAI client — pulse analysis + chat Q&A
│   ├── collectors/
│   │   ├── postCollector.ts       # Fetches new posts + top comments from Reddit
│   │   ├── commentCollector.ts    # Fetches additional comments
│   │   ├── statsCollector.ts      # Hourly subreddit subscriber/active snapshots
│   │   └── sentimentCollector.ts  # Runs Community Pulse analysis + stores result
│   ├── store/
│   │   ├── db.ts                  # SQLite via better-sqlite3 — all queries
│   │   └── collectionState.ts     # In-memory last-run timestamps
│   └── dashboard/
│       ├── server.ts              # Express REST API
│       └── chatJobs.ts            # Background chat job queue + session context
├── dist/                          # Compiled JS (after npm run build)
├── .env                           # Environment variables (not in git)
├── package.json
└── tsconfig.json
```

---

## Troubleshooting

### Bot not collecting posts

```bash
pm2 logs community-pulse --lines 50
```

Check for Arctic Shift API errors. The collector retries automatically every `POST_POLL_INTERVAL_MIN` minutes.

### Community Pulse not running

- Check that `OPENAI_API_KEY` is set in `.env`
- Verify `SENTIMENT_HOUR` matches the expected UTC hour
- Look for errors in `pm2 logs community-pulse`

### API returns 401

- The `Authorization: Bearer` header must exactly match `REDDIT_DASHBOARD_SECRET` in `.env`
- Check that the matching `REDDIT_SECRET` in the frontend `.env` is the same value
- Rebuild and restart after any `.env` change: `npm run build && pm2 restart community-pulse`

### Database file not found

- Check that `REDDIT_DB_PATH` points to an existing writable directory
- If using a Hetzner volume (`/mnt/HC_Volume_...`), ensure it is mounted: `df -h`
- The bot creates the database file automatically on first run

### Frontend shows stale data

- Community Pulse runs once per day. Use the Trigger button on the Reddit dashboard overview to force an immediate run.
- Posts refresh every 15 minutes (configurable via `POST_POLL_INTERVAL_MIN`).
