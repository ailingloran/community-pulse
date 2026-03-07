import { fetchSubredditInfo } from '../api/reddit';
import { insertSnapshot } from '../store/db';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Take a subreddit subscriber + active user snapshot and persist it.
 */
export async function collectSubredditStats(): Promise<void> {
  const info = await fetchSubredditInfo(config.subreddit);
  insertSnapshot(info.subscribers, info.active_user_count);
  logger.info(
    `[statsCollector] Snapshot: ${info.subscribers.toLocaleString()} subscribers, ` +
    `${info.active_user_count} active`,
  );
}
