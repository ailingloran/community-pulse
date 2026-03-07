import cron from 'node-cron';
import { collectNewPosts } from './collectors/postCollector';
import { collectCommentsForPosts } from './collectors/commentCollector';
import { collectSubredditStats } from './collectors/statsCollector';
import { collectSentiment } from './collectors/sentimentCollector';
import { config } from './config';
import { logger } from './logger';

export function startScheduler(): void {
  // ── Posts + comments every 15 minutes ───────────────────────────────────────
  const postInterval = config.postPollIntervalMin;
  cron.schedule(`*/${postInterval} * * * *`, async () => {
    logger.info('[scheduler] Post collection triggered');
    try {
      const newPostIds = await collectNewPosts();
      if (newPostIds.length > 0) {
        await collectCommentsForPosts(newPostIds);
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
