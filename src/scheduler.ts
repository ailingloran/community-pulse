import cron, { ScheduledTask } from 'node-cron';
import { collectNewPosts } from './collectors/postCollector';
import { collectCommentsForPosts } from './collectors/commentCollector';
import { collectSubredditStats } from './collectors/statsCollector';
import { collectSentiment } from './collectors/sentimentCollector';
import { getPostIdsYoungerThan, getSetting } from './store/db';
import { config } from './config';
import { logger } from './logger';

let sentimentTask: ScheduledTask | null = null;

export function rescheduleReportCron(hour: number): void {
  sentimentTask?.stop();
  sentimentTask = cron.schedule(`0 ${hour} * * *`, async () => {
    if (getSetting('sentiment_enabled', 'true') !== 'true') {
      logger.info('[scheduler] Daily sentiment skipped — disabled in settings');
      return;
    }
    logger.info('[scheduler] Daily sentiment analysis triggered');
    try {
      await collectSentiment();
    } catch (err) {
      logger.error('[scheduler] Sentiment analysis failed:', err);
    }
  });
  logger.info(`[scheduler] Sentiment report scheduled for ${hour}:00 UTC`);
}

export function startScheduler(): void {
  // ── Posts + comments every 15 minutes ───────────────────────────────────────
  const postInterval = config.postPollIntervalMin;
  cron.schedule(`*/${postInterval} * * * *`, async () => {
    logger.info('[scheduler] Post collection triggered');
    try {
      const newPostIds = await collectNewPosts();

      // Re-fetch comments for ALL posts younger than 3 days, not just new ones.
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

  // ── Daily sentiment at configured hour (UTC, overridable via settings) ───────
  const initialHour = parseInt(getSetting('sentiment_hour', String(config.sentimentHour)), 10);
  rescheduleReportCron(initialHour);

  logger.info(
    `[scheduler] Started — posts every ${postInterval}min, stats every ${statsInterval}min, sentiment daily at ${initialHour}:00 UTC`,
  );
}
