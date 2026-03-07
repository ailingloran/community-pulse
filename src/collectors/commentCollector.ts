import { fetchPostComments } from '../api/reddit';
import { bulkInsertComments, CommentRow } from '../store/db';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Fetch and store all comments for a list of post IDs.
 * Uses INSERT OR IGNORE so re-running is safe.
 */
export async function collectCommentsForPosts(postIds: string[]): Promise<void> {
  if (postIds.length === 0) return;

  let totalInserted = 0;

  for (const postId of postIds) {
    try {
      const comments = await fetchPostComments(config.subreddit, postId);
      const now = new Date().toISOString();

      const rows: CommentRow[] = comments.map(c => ({
        comment_id:  c.id,
        post_id:     postId,
        parent_id:   c.parent_id,
        author:      c.author,
        body:        c.body,
        score:       c.score,
        created_utc: c.created_utc,
        collected_at: now,
      }));

      const inserted = bulkInsertComments(rows);
      totalInserted += inserted;

      logger.debug(`[commentCollector] Post ${postId}: ${inserted}/${comments.length} comments stored`);

      // Respect Reddit rate limits — small delay between posts
      await sleep(500);
    } catch (err) {
      logger.warn(`[commentCollector] Failed to fetch comments for post ${postId}:`, err);
    }
  }

  if (totalInserted > 0) {
    logger.info(`[commentCollector] ${totalInserted} new comment(s) stored across ${postIds.length} post(s)`);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
