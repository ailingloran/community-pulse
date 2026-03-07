/**
 * Reddit API client — OAuth2 client_credentials flow.
 * Tokens last 1 hour and are refreshed automatically.
 */

import { config } from '../config';
import { logger } from '../logger';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE  = 'https://oauth.reddit.com';

interface TokenResponse {
  access_token: string;
  expires_in:   number;
  token_type:   string;
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const credentials = Buffer.from(
    `${config.redditClientId}:${config.redditClientSecret}`,
  ).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': config.redditUserAgent,
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`Reddit OAuth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as TokenResponse;
  cachedToken    = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  logger.info('[reddit] OAuth token refreshed');
  return cachedToken;
}

async function redditGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const token = await getToken();
  const url   = new URL(`${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': config.redditUserAgent,
    },
  });

  if (!res.ok) {
    throw new Error(`Reddit API error ${res.status}: ${path}`);
  }

  return res.json() as Promise<T>;
}

// ── Public types ───────────────────────────────────────────────────────────────

export interface RedditPost {
  id:           string;
  title:        string;
  author:       string;
  score:        number;
  upvote_ratio: number;
  num_comments: number;
  link_flair_text: string | null;
  url:          string;
  permalink:    string;
  selftext:     string;
  created_utc:  number;
  is_self:      boolean;
}

export interface RedditComment {
  id:          string;
  parent_id:   string;  // t1_xxx (comment) or t3_xxx (post)
  author:      string;
  body:        string;
  score:       number;
  created_utc: number;
}

export interface SubredditInfo {
  subscribers:   number;
  active_user_count: number;
}

// ── API methods ────────────────────────────────────────────────────────────────

/** Fetch up to `limit` newest posts from the subreddit. */
export async function fetchNewPosts(subreddit: string, limit = 100): Promise<RedditPost[]> {
  const data = await redditGet<any>(`/r/${subreddit}/new`, {
    limit: String(limit),
    raw_json: '1',
  });
  return data.data.children.map((c: any) => c.data as RedditPost);
}

/** Fetch all comments for a given post (flattened tree). */
export async function fetchPostComments(
  subreddit: string,
  postId: string,
): Promise<RedditComment[]> {
  // Reddit returns [postListing, commentListing]
  const data = await redditGet<any[]>(`/r/${subreddit}/comments/${postId}`, {
    limit: '500',
    depth: '10',
    raw_json: '1',
  });

  const commentListing = data[1];
  return flattenComments(commentListing.data.children);
}

function flattenComments(children: any[]): RedditComment[] {
  const results: RedditComment[] = [];
  for (const child of children) {
    if (child.kind === 't1' && child.data.author !== '[deleted]') {
      results.push({
        id:          child.data.id,
        parent_id:   child.data.parent_id,
        author:      child.data.author,
        body:        child.data.body,
        score:       child.data.score,
        created_utc: child.data.created_utc,
      });
      // Recurse into replies
      if (child.data.replies && child.data.replies.data?.children) {
        results.push(...flattenComments(child.data.replies.data.children));
      }
    }
  }
  return results;
}

/** Fetch subreddit subscriber count and active users. */
export async function fetchSubredditInfo(subreddit: string): Promise<SubredditInfo> {
  const data = await redditGet<any>(`/r/${subreddit}/about`, { raw_json: '1' });
  return {
    subscribers:       data.data.subscribers,
    active_user_count: data.data.active_user_count,
  };
}
