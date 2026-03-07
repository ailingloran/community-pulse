import 'node:process';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  // Reddit OAuth (script app — client credentials)
  redditClientId:     required('REDDIT_CLIENT_ID'),
  redditClientSecret: required('REDDIT_CLIENT_SECRET'),
  redditUserAgent:    process.env.REDDIT_USER_AGENT ?? 'wows-reddit-scraper/1.0 (by /u/bloodminister)',

  // Target subreddit (without r/)
  subreddit: process.env.REDDIT_SUBREDDIT ?? 'WorldOfWarships',

  // Storage
  dbPath: process.env.REDDIT_DB_PATH ?? '/mnt/HC_Volume_105012469/reddit.db',

  // Dashboard API
  dashboardPort:   parseInt(process.env.REDDIT_DASHBOARD_PORT ?? '3002', 10),
  dashboardSecret: process.env.REDDIT_DASHBOARD_SECRET ?? '',

  // Collection settings
  postPollIntervalMin:  parseInt(process.env.POST_POLL_INTERVAL_MIN  ?? '15', 10),
  statsPollIntervalMin: parseInt(process.env.STATS_POLL_INTERVAL_MIN ?? '60', 10),
};
