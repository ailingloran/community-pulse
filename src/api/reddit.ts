/**
 * Reddit API client — public JSON endpoints, no auth required.
 * Falls back gracefully if Reddit blocks the IP.
 *
 * When/if OAuth credentials become available, swap BASE_URL back to
 * https://oauth.reddit.com and re-add the token fetch logic.
 */

import { config } from '../config';
import { logger } from '../logger';

const BASE_URL = 'https://www.reddit.com';

// Minimum ms between requests — be a polite scraper
const REQUEST_DELAY_MS = 2000;

let lastRequestAt = 0;

async function redditGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  // Throttle: wait until at least REQUEST_DELAY_MS since last call
  const now = Date.now();
  const wait = REQUEST_DELAY_MS - (now - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();

  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('raw_json', '1');
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': config.redditUserAgent,
      'Accept': 'application/json',
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '60', 10);
    logger.warn(`[reddit] Rate limited — waiting ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return redditGet<T>(path, params);
  }

  if (res.status === 403) {
    throw new Error(`Reddit blocked this IP (403). Server IP may be on a blocklist.`);
  }

  if (!res.ok) {
    throw new Error(`Reddit request failed: ${res.status} ${url.toString()}`);
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
  const data = await redditGet<any>(`/r/${subreddit}/new.json`, {
    limit: String(Math.min(limit, 100)),
  });
  return data.data.children.map((c: any) => c.data as RedditPost);
}

export async function fetchPostComments(
  subreddit: string,
  postId: string,
): Promise<RedditComment[]> {
  const data = await redditGet<any[]>(`/r/${subreddit}/comments/${postId}.json`, {
    limit: '500',
    depth: '10',
  });
  const commentListing = data[1];
  return flattenComments(commentListing.data.children);
}

function flattenComments(children: any[]): RedditComment[] {
  const results: RedditComment[] = [];
  for (const child of children) {
    if (
      child.kind === 't1' &&
      child.data.author !== '[deleted]' &&
      child.data.body !== '[deleted]'
    ) {
      results.push({
        id:          child.data.id,
        parent_id:   child.data.parent_id,
        author:      child.data.author,
        body:        child.data.body,
        score:       child.data.score,
        created_utc: child.data.created_utc,
      });
      if (child.data.replies?.data?.children) {
        results.push(...flattenComments(child.data.replies.data.children));
      }
    }
  }
  return results;
}

export async function fetchSubredditInfo(subreddit: string): Promise<SubredditInfo> {
  const data = await redditGet<any>(`/r/${subreddit}/about.json`);
  return {
    subscribers:       data.data.subscribers,
    active_user_count: data.data.active_user_count,
  };
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
