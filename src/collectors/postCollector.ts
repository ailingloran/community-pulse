import { fetchNewPosts } from '../api/reddit';
import { insertPost, getPostById, PostRow } from '../store/db';
import { markCollectionAttempt } from '../store/collectionState';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Fetch the latest posts from the subreddit and store any new ones.
 * Returns the list of newly inserted post IDs (for comment collection).
 */
export async function collectNewPosts(): Promise<string[]> {
  markCollectionAttempt();
  const posts = await fetchNewPosts(config.subreddit, 100);
  const newPostIds: string[] = [];
  const now = new Date().toISOString();

  for (const post of posts) {
    const row: PostRow = {
      post_id:      post.id,
      subreddit:    config.subreddit,
      title:        post.title,
      author:       post.author ?? null,
      score:        post.score,
      upvote_ratio: post.upvote_ratio,
      num_comments: post.num_comments,
      flair:        post.link_flair_text ?? null,
      url:          post.url,
      permalink:    post.permalink,
      selftext:     post.selftext || null,
      created_utc:  post.created_utc,
      collected_at: now,
    };

    const inserted = insertPost(row);
    if (inserted) {
      newPostIds.push(post.id);
    }
  }

  if (newPostIds.length > 0) {
    logger.info(`[postCollector] ${newPostIds.length} new post(s) stored`);
  } else {
    logger.debug('[postCollector] No new posts');
  }

  return newPostIds;
}
