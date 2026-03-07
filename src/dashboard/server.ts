import express, { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';
import {
  getPostsBetween,
  getCommentsByPost,
  getAllSnapshots,
  getSnapshotsBetween,
  countPostsSince,
} from '../store/db';

const app = express();
app.use(express.json());

// ── Auth middleware ────────────────────────────────────────────────────────────

function auth(req: Request, res: Response, next: NextFunction): void {
  if (!config.dashboardSecret) { next(); return; }
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${config.dashboardSecret}`) { next(); return; }
  res.status(401).json({ error: 'Unauthorized' });
}

app.use(auth);

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  res.json({
    ok: true,
    postsLast24h: countPostsSince(dayAgo),
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

/** Posts within a date range (?from=ISO&to=ISO, default last 30 days). */
app.get('/api/posts', (req, res) => {
  try {
    const to   = new Date();
    const days = parseInt((req.query.days as string) || '30', 10);
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

/** Manually trigger a post + comment collection run. */
app.post('/api/trigger/collect', (_req, res) => {
  import('../collectors/postCollector').then(async ({ collectNewPosts }) => {
    const { collectCommentsForPosts } = await import('../collectors/commentCollector');
    collectNewPosts()
      .then(ids => collectCommentsForPosts(ids))
      .catch((err: unknown) => logger.error('[dashboard] Manual collect failed:', err));
    res.json({ ok: true, message: 'Collection triggered' });
  }).catch(() => res.status(500).json({ error: 'Failed to load collector' }));
});

// ── Start ──────────────────────────────────────────────────────────────────────

export function startDashboard(): void {
  app.listen(config.dashboardPort, () => {
    logger.info(`[dashboard] API listening on port ${config.dashboardPort}`);
  });
}
