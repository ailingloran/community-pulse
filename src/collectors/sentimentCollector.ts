import { getDb, insertSentimentReport, PostRow, CommentRow } from '../store/db';
import { config } from '../config';
import { logger } from '../logger';
import { analyseCommunityPulse } from '../api/openai';

export async function collectSentiment(): Promise<void> {
  if (!config.openaiApiKey) {
    logger.warn('[sentiment] OPENAI_API_KEY not set — skipping');
    return;
  }

  const db = getDb();
  const nowSec  = Math.floor(Date.now() / 1000);
  const dayAgo  = nowSec - 24 * 3600;

  // Get top posts from last 24h (by score, capped at 50)
  const posts = db
    .prepare(`
      SELECT * FROM posts
      WHERE created_utc >= ?
      ORDER BY score DESC
      LIMIT 50
    `)
    .all(dayAgo) as PostRow[];

  if (posts.length < 3) {
    logger.warn(`[sentiment] Only ${posts.length} posts in last 24h — skipping`);
    return;
  }

  // Load top comments for each post
  const commentsByPost = new Map<string, CommentRow[]>();
  for (const p of posts) {
    const comments = db
      .prepare(`
        SELECT * FROM comments
        WHERE post_id = ?
        ORDER BY score DESC
        LIMIT 10
      `)
      .all(p.post_id) as CommentRow[];
    commentsByPost.set(p.post_id, comments);
  }

  logger.info(`[sentiment] Analysing ${posts.length} posts with OpenAI...`);

  try {
    const result = await analyseCommunityPulse(posts, commentsByPost);
    insertSentimentReport(result.mood, JSON.stringify(result));
    logger.info(`[sentiment] Complete — mood score ${result.mood_score}/5: ${result.mood}`);
  } catch (err) {
    logger.error('[sentiment] Analysis failed:', err);
  }
}
