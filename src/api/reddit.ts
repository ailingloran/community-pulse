/**
 * Arctic Shift API client — public Reddit archive, no credentials needed.
 * https://arctic-shift.photon-reddit.com
 *
 * Replaces direct Reddit endpoints which block Hetzner IPs (403).
 * Arctic Shift has no IP restrictions and no auth requirements.
 * Data is typically a few hours behind real-time — fine for analytics.
 */

import { logger } from '../logger';

const BASE_URL = 'https://arctic-shift.photon-reddit.com/api';

// Throttle to be a polite requester
const REQUEST_DELAY_MS = 500;

let lastRequestAt = 0;

async function arcticGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const now = Date.now();
  const wait = REQUEST_DELAY_MS - (now - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  logger.debug(`[arctic] GET ${url.toString()}`);

  const res = await fetch(url.toString(), {
    headers: {
      'Accept':     'application/json',
      'User-Agent': 'community-pulse/1.0',
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10);
    logger.warn(`[arctic] Rate limited — waiting ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return arcticGet<T>(path, params);
  }

  if (!res.ok) {
    throw new Error(`Arctic Shift request failed: ${res.status} ${url.toString()}`);
  }

  return res.json() as Promise<T>;
}

// ── Public types ───────────────────────────────────────────────────────────────

export interface RedditPost {
  id:              string;
  title:           string;
  author:          string;
  score:           number;
  upvote_ratio:    number;
  num_comments:    number;
  link_flair_text: string | null;
  url:             string;
  permalink:       string;
  selftext:        string;
  created_utc:     number;
  is_self:         boolean;
}

export interface RedditComment {
  id:          string;
  parent_id:   string;
  author:      string;
  body:        string;
  score:       number;
  created_utc: number;
}

export interface SubredditInfo {
  subscribers:       number;
  active_user_count: number;
}

// ── API methods ────────────────────────────────────────────────────────────────

export async function fetchNewPosts(subreddit: string, limit = 100): Promise<RedditPost[]> {
  const data = await arcticGet<{ data: any[] }>('/posts/search', {
    subreddit,
    limit: String(Math.min(limit, 100)),
  });
  return (data.data ?? []).map(normalizePost);
}

export async function fetchPostComments(
  _subreddit: string,
  postId: string,
): Promise<RedditComment[]> {
  // Arctic Shift caps comments at 100 per request — paginate with `after` cursor
  const PAGE_LIMIT = 100;
  const MAX_PAGES  = 20;   // safety cap: 2000 comments max per post
  const all: any[] = [];
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      link_id: `t3_${postId}`,
      limit:   String(PAGE_LIMIT),
    };
    if (after) params.after = after;

    const data = await arcticGet<{ data: any[] }>('/comments/search', params);
    const batch = data.data ?? [];
    all.push(...batch);

    // Stop when we get fewer results than requested (last page)
    if (batch.length < PAGE_LIMIT) break;

    // Use the created_utc of the last item as the next cursor
    const last = batch[batch.length - 1];
    after = String(last.created_utc);
  }

  return all
    .filter(c =>
      c.author !== '[deleted]' &&
      c.body   !== '[deleted]' &&
      c.body   !== '[removed]',
    )
    .map(c => ({
      id:          c.id,
      parent_id:   c.parent_id,
      author:      c.author ?? '[deleted]',
      body:        c.body ?? '',
      score:       toNumber(c.score),
      created_utc: toNumber(c.created_utc),
    }));
}

/**
 * Arctic Shift is an archive — it doesn't track live active-user counts.
 * Subscriber count is pulled from the subreddit_subscribers field on posts.
 * active_user_count is always returned as 0 (not available via archive).
 */
export async function fetchSubredditInfo(subreddit: string): Promise<SubredditInfo> {
  try {
    const data = await arcticGet<{ data: any[] }>('/posts/search', {
      subreddit,
      limit: '1',
    });
    const post = data.data?.[0];
    if (post?.subreddit_subscribers) {
      return {
        subscribers:       toNumber(post.subreddit_subscribers),
        active_user_count: 0,
      };
    }
  } catch (err) {
    logger.warn(`[arctic] Could not fetch subreddit info: ${err}`);
  }
  return { subscribers: 0, active_user_count: 0 };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function normalizePost(p: any): RedditPost {
  return {
    id:              p.id,
    title:           p.title ?? '',
    author:          p.author ?? '[deleted]',
    score:           toNumber(p.score),
    upvote_ratio:    toNumber(p.upvote_ratio),
    num_comments:    toNumber(p.num_comments),
    link_flair_text: p.link_flair_text ?? null,
    url:             p.url ?? '',
    permalink:       p.permalink ?? `/r/${p.subreddit}/comments/${p.id}/`,
    selftext:        p.selftext ?? '',
    created_utc:     toNumber(p.created_utc),
    is_self:         p.is_self ?? false,
  };
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v) || 0;
  return 0;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
