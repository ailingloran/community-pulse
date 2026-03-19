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
  getSentimentReportTrend,
  getSetting,
  setSetting,
} from '../store/db';
import { rescheduleReportCron } from '../scheduler';
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

app.get('/api/sentiment/trend', (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    res.json(getSentimentReportTrend(days));
  } catch (err) {
    logger.error('[dashboard] /api/sentiment/trend error:', err);
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

// ── Settings ───────────────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json({
    sentiment_enabled:  getSetting('sentiment_enabled', 'true') === 'true',
    sentiment_hour:     parseInt(getSetting('sentiment_hour', String(config.sentimentHour)), 10),
    analysis_days:      parseInt(getSetting('analysis_days', '1'), 10),
    max_posts:          parseInt(getSetting('max_posts', '50'), 10),
    max_comments:       parseInt(getSetting('max_comments', '15'), 10),
  });
});

app.post('/api/settings', (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    if ('sentiment_enabled' in body) {
      setSetting('sentiment_enabled', body.sentiment_enabled ? 'true' : 'false');
    }
    if ('sentiment_hour' in body) {
      const hour = Math.min(23, Math.max(0, Number(body.sentiment_hour)));
      setSetting('sentiment_hour', String(hour));
      rescheduleReportCron(hour);
    }
    if ('analysis_days' in body) {
      setSetting('analysis_days', String(Math.min(7, Math.max(1, Number(body.analysis_days)))));
    }
    if ('max_posts' in body) {
      setSetting('max_posts', String(Math.min(200, Math.max(10, Number(body.max_posts)))));
    }
    if ('max_comments' in body) {
      setSetting('max_comments', String(Math.min(30, Math.max(1, Number(body.max_comments)))));
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('[dashboard] POST /api/settings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
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
    const { question, windowHours = 0, collectCap = 300, sessionId } = req.body as {
      question:     string;
      windowHours?: number;
      collectCap?:  number;
      sessionId?:   string;
    };
    if (!question?.trim()) {
      res.status(400).json({ error: 'question is required' });
      return;
    }
    // windowHours = 0 means "all time" (no cutoff); clamp to [0, 720]
    const cappedHours = Math.min(Math.max(Number(windowHours), 0), 720);
    const cappedCap   = Math.min(Math.max(Number(collectCap) || 300, 10), 2000);
    const job = createChatJob(question.trim(), cappedHours, cappedCap, sessionId);
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
