import 'dotenv/config';
import { initDb, getPostIdsWithoutComments } from './store/db';
import { startDashboard } from './dashboard/server';
import { startScheduler } from './scheduler';
import { collectNewPosts } from './collectors/postCollector';
import { collectCommentsForPosts } from './collectors/commentCollector';
import { collectSubredditStats } from './collectors/statsCollector';
import { logger } from './logger';

async function main() {
  logger.info('=== WoWS Reddit Collector starting ===');

  // 1. Open DB
  initDb();

  // 2. Start REST API
  startDashboard();

  const args = process.argv.slice(2);

  // ── Manual backfill mode: collect once and exit ────────────────────────────
  if (args.includes('--collect')) {
    logger.info('Manual collect mode: running once then exiting...');
    try {
      await collectSubredditStats();
      const newIds = await collectNewPosts();

      // Also backfill any existing posts that have no comments yet
      const uncommentedIds = getPostIdsWithoutComments();
      const toFetch = [...new Set([...newIds, ...uncommentedIds])];
      if (uncommentedIds.length > 0) {
        logger.info(`[backfill] ${uncommentedIds.length} post(s) have no comments — fetching now`);
      }

      await collectCommentsForPosts(toFetch);
    } catch (err) {
      logger.error('Manual collect failed:', err);
      process.exit(1);
    }
    logger.info('Manual collect complete. Exiting.');
    process.exit(0);
  }

  // 3. Run an immediate collection on startup so there's no gap on first boot
  logger.info('Running initial collection...');
  try {
    await collectSubredditStats();
    const newIds = await collectNewPosts();
    await collectCommentsForPosts(newIds);
    logger.info('Initial collection complete');
  } catch (err) {
    logger.warn('Initial collection failed (will retry on next cron tick):', err);
  }

  // 4. Start scheduler
  startScheduler();

  logger.info('=== WoWS Reddit Collector running ===');
}

main().catch(err => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
