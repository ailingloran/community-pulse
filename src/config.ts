import 'node:process';

export const config = {
  // Target subreddit (without r/)
  subreddit: process.env.REDDIT_SUBREDDIT ?? 'WorldOfWarships',

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  // Hour (UTC) at which to auto-run daily sentiment analysis (default 8am UTC)
  sentimentHour: parseInt(process.env.SENTIMENT_HOUR ?? '8', 10),

  // Storage
  dbPath: process.env.REDDIT_DB_PATH ?? '/mnt/HC_Volume_105012469/reddit.db',

  // Dashboard API
  dashboardPort:   parseInt(process.env.REDDIT_DASHBOARD_PORT ?? '3002', 10),
  dashboardSecret: process.env.REDDIT_DASHBOARD_SECRET ?? '',

  // Collection settings
  postPollIntervalMin:  parseInt(process.env.POST_POLL_INTERVAL_MIN  ?? '15', 10),
  statsPollIntervalMin: parseInt(process.env.STATS_POLL_INTERVAL_MIN ?? '60', 10),
};
