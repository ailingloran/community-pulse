import cron from 'node-cron';
import { collectNewPosts } from './collectors/postCollector';
import { collectCommentsForPosts } from './collectors/commentCollector';
import { collectSubredditStats } from './collectors/statsCollector';
import { collectSentiment } from './collectors/sentimentCollector';
import { getPostIdsYoungerThan } from './store/db';
import { config } from './config';
import { logger } from './logger';

export function startScheduler(): void {
  // ── Posts + comments every 15 minutes ───────────────────────────────────────
  const postInterval = config.postPollIntervalMin;
  cron.schedule(`*/${postInterval} * * * *`, async () => {
    logger.info('[scheduler] Post collection triggered');
    try {
      const newPostIds = await collectNewPosts();

      // Re-fetch comments for ALL posts younger than 3 days, not just new ones.
      // Posts accumulate comments over time — without this, a post scraped with
      // 0 comments would never have its comments updated.
      // INSERT OR IGNORE on comments means duplicates are safely skipped.
      const recentPostIds = getPostIdsYoungerThan(3);
      const toFetch = [...new Set([...newPostIds, ...recentPostIds])];

      if (toFetch.length > 0) {
        logger.info(`[scheduler] Fetching comments for ${toFetch.length} post(s) (${newPostIds.length} new, ${recentPostIds.length} recent)`);
        await collectCommentsForPosts(toFetch);
      }
    } catch (err) {
      logger.error('[scheduler] Post collection failed:', err);
    }
  });

  // ── Subreddit stats every hour ───────────────────────────────────────────────
  const statsInterval = config.statsPollIntervalMin;
  cron.schedule(`*/${statsInterval} * * * *`, async () => {
    logger.info('[scheduler] Stats collection triggered');
    try {
      await collectSubredditStats();
    } catch (err) {
      logger.error('[scheduler] Stats collection failed:', err);
    }
  });

  // ── Daily sentiment analysis at configured hour (UTC) ───────────────────────
  cron.schedule(`0 ${config.sentimentHour} * * *`, async () => {
    logger.info('[scheduler] Daily sentiment analysis triggered');
    try {
      await collectSentiment();
    } catch (err) {
      logger.error('[scheduler] Sentiment analysis failed:', err);
    }
  });

  logger.info(
    `[scheduler] Started — posts every ${postInterval}min, stats every ${statsInterval}min, sentiment daily at ${config.sentimentHour}:00 UTC`,
  );
}
