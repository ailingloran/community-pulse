import express, { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import {
  getPostsBetween,
  getCommentsByPost,
  getAllSnapshots,
  countPostsSince,
  countAllPosts,
  countAllComments,
  getLatestSnapshot,
  getLastCollectedAt,
  getPostsPerDay,
  getSentimentReports,
} from '../store/db';
import { getLastAttemptedAt } from '../store/collectionState';
import {
  createChatJob,
  getChatJobResponse,
  getChatHistory,
  removeChatJob,
} from './chatJobs';

const app = express();
app.use(express.json());

// Simple in-memory rate limiter for expensive AI endpoints (max 10/min globally)
const chatTimestamps: number[] = [];
function chatRateLimitOk(): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  while (chatTimestamps.length > 0 && chatTimestamps[0] < cutoff) chatTimestamps.shift();
  if (chatTimestamps.length >= 10) return false;
  chatTimestamps.push(now);
  return true;
}

// ── Auth middleware ────────────────────────────────────────────────────────────

function auth(req: Request, res: Response, next: NextFunction): void {
  if (!config.dashboardSecret) {
    res.status(500).json({ error: 'Server misconfigured: REDDIT_DASHBOARD_SECRET not set' });
    return;
  }
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${config.dashboardSecret}`) { next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(auth);

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  res.json({
    ok:             true,
    postsLast24h:     countPostsSince(dayAgo),
    totalPosts:       countAllPosts(),
    totalComments:    countAllComments(),
    latestSnapshot:    getLatestSnapshot() ?? null,
    lastCollectedAt:   getLastCollectedAt() ?? null,
    lastAttemptedAt:   getLastAttemptedAt() ?? null,
  });
});

/** All subreddit subscriber snapshots (for growth chart). */
app.get('/api/snapshots', (_req, res) => {
  try {
    res.json(getAllSnapshots());
  } catch (err) {
    logger.error('[dashboard] /api/snapshots error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Posts within a date range (?days=30). */
app.get('/api/posts', (req, res) => {
  try {
    const to   = new Date();
    const days = Math.min(365, Math.max(1, parseInt((req.query.days as string) || '30', 10)));
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
    const rows = getPostsBetween(from.toISOString(), to.toISOString());
    res.json(rows);
  } catch (err) {
    logger.error('[dashboard] /api/posts error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Comments for a specific post. */
app.get('/api/posts/:postId/comments', (req, res) => {
  try {
    const rows = getCommentsByPost(req.params.postId);
    res.json(rows);
  } catch (err) {
    logger.error('[dashboard] /api/posts/:id/comments error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Posts-per-day + snapshots for trend charts (?days=30). */
app.get('/api/trends', (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt((req.query.days as string) || '30', 10)));
    res.json({
      postsPerDay: getPostsPerDay(days),
      snapshots:   getAllSnapshots(),
    });
  } catch (err) {
    logger.error('[dashboard] /api/trends error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Sentiment ──────────────────────────────────────────────────────────────────

app.get('/api/sentiment', (req, res) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || '30', 10), 100);
    res.json(getSentimentReports(limit));
  } catch (err) {
    logger.error('[dashboard] /api/sentiment error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/trigger/sentiment', (_req, res) => {
  import('../collectors/sentimentCollector').then(({ collectSentiment }) => {
    collectSentiment().catch((err: unknown) =>
      logger.error('[dashboard] Manual sentiment failed:', err),
    );
    res.json({ ok: true, message: 'Sentiment analysis triggered' });
  }).catch(() => res.status(500).json({ error: 'Failed to load collector' }));
});

// ── Collection trigger ────────────────────────────────────────────────────────

app.post('/api/trigger/collect', (_req, res) => {
  import('../collectors/postCollector').then(async ({ collectNewPosts }) => {
    const { collectCommentsForPosts } = await import('../collectors/commentCollector');
    collectNewPosts()
      .then(ids => collectCommentsForPosts(ids))
      .catch((err: unknown) => logger.error('[dashboard] Manual collect failed:', err));
    res.json({ ok: true, message: 'Collection triggered' });
  }).catch(() => res.status(500).json({ error: 'Failed to load collector' }));
});

// ── Chat jobs ─────────────────────────────────────────────────────────────────

app.get('/api/chat', (req, res) => {
  try {
    const page     = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) || '20', 10)));
    res.json(getChatHistory(page, pageSize));
  } catch (err) {
    logger.error('[dashboard] GET /api/chat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/chat', (req, res) => {
  if (!chatRateLimitOk()) {
    res.status(429).json({ error: 'Too many chat requests — wait a moment and try again' });
    return;
  }
  try {
    const { question, windowHours = 24, collectCap = 300 } = req.body as {
      question:     string;
      windowHours?: number;
      collectCap?:  number;
    };
    if (!question?.trim()) {
      res.status(400).json({ error: 'question is required' });
      return;
    }
    const job = createChatJob(question.trim(), windowHours, collectCap);
    res.status(202).json(job);
  } catch (err) {
    logger.error('[dashboard] POST /api/chat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/chat/:jobId', (req, res) => {
  try {
    const job = getChatJobResponse(req.params.jobId);
    if (!job) { res.status(404).json({ error: 'Chat job not found' }); return; }
    res.json(job);
  } catch (err) {
    logger.error('[dashboard] GET /api/chat/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/chat/:jobId', (req, res) => {
  try {
    const result = removeChatJob(req.params.jobId);
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      const error  = result.reason === 'not_found'
        ? 'Chat job not found'
        : 'Chat job is still running and cannot be deleted yet';
      res.status(status).json({ error });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('[dashboard] DELETE /api/chat/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

export function startDashboard(): void {
  app.listen(config.dashboardPort, () => {
    logger.info(`[dashboard] API listening on port ${config.dashboardPort}`);
  });
}
