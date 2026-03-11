import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../logger';

let db: Database.Database;

export function getDb(): Database.Database {
  return db;
}

export function initDb(): void {
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      post_id       TEXT PRIMARY KEY,
      subreddit     TEXT NOT NULL,
      title         TEXT NOT NULL,
      author        TEXT,
      score         INTEGER,
      upvote_ratio  REAL,
      num_comments  INTEGER,
      flair         TEXT,
      url           TEXT,
      permalink     TEXT,
      selftext      TEXT,
      created_utc   INTEGER NOT NULL,
      collected_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      comment_id   TEXT PRIMARY KEY,
      post_id      TEXT NOT NULL,
      parent_id    TEXT,
      author       TEXT,
      body         TEXT,
      score        INTEGER,
      created_utc  INTEGER NOT NULL,
      collected_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subreddit_snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      taken_at     TEXT NOT NULL,
      subscribers  INTEGER,
      active_users INTEGER
    );

    CREATE TABLE IF NOT EXISTS sentiment_reports (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      taken_at  TEXT NOT NULL,
      mood      TEXT,
      raw_json  TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_jobs (
      id            TEXT PRIMARY KEY,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      question      TEXT NOT NULL,
      window_hours  INTEGER NOT NULL,
      collect_cap   INTEGER NOT NULL,
      status        TEXT NOT NULL,
      answer        TEXT,
      collected     INTEGER,
      analysed      INTEGER,
      error         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_posts_created   ON posts    (created_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_flair      ON posts    (flair);
    CREATE INDEX IF NOT EXISTS idx_comments_post    ON comments (post_id);
    CREATE INDEX IF NOT EXISTS idx_comments_created ON comments (created_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_time   ON subreddit_snapshots (taken_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sentiment_time   ON sentiment_reports (taken_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_created     ON chat_jobs (created_at DESC);

    -- FTS5 index for fast, relevance-ranked search across posts + comments.
    -- Stores searchable text plus the parent post_id for result aggregation.
    CREATE VIRTUAL TABLE IF NOT EXISTS content_fts
      USING fts5(text, post_id UNINDEXED);

    -- Keep FTS in sync with new posts and comments.
    -- Updates to score/num_comments don't need FTS sync (text unchanged).
    CREATE TRIGGER IF NOT EXISTS posts_fts_ai
      AFTER INSERT ON posts BEGIN
        INSERT INTO content_fts(text, post_id)
          VALUES (new.title || ' ' || COALESCE(new.selftext, ''), new.post_id);
      END;

    CREATE TRIGGER IF NOT EXISTS comments_fts_ai
      AFTER INSERT ON comments BEGIN
        INSERT INTO content_fts(text, post_id)
          VALUES (COALESCE(new.body, ''), new.post_id);
      END;
  `);

  // Populate FTS index from existing rows on first run after adding FTS support.
  const { n: postsCount } = db
    .prepare('SELECT COUNT(*) AS n FROM posts')
    .get() as { n: number };
  if (postsCount > 0) {
    const { n: ftsCount } = db
      .prepare('SELECT COUNT(*) AS n FROM content_fts')
      .get() as { n: number };
    if (ftsCount === 0) {
      logger.info('[db] FTS index empty — rebuilding from existing posts and comments...');
      rebuildContentFts();
      logger.info('[db] FTS rebuild complete');
    }
  }

  logger.info(`[db] Reddit DB opened at ${config.dbPath}`);
}

// ── Posts ──────────────────────────────────────────────────────────────────────

export interface PostRow {
  post_id:      string;
  subreddit:    string;
  title:        string;
  author:       string | null;
  score:        number | null;
  upvote_ratio: number | null;
  num_comments: number | null;
  flair:        string | null;
  url:          string | null;
  permalink:    string | null;
  selftext:     string | null;
  created_utc:  number;
  collected_at: string;
}

const insertPostStmt = () => getDb().prepare(`
  INSERT OR IGNORE INTO posts
    (post_id, subreddit, title, author, score, upvote_ratio, num_comments,
     flair, url, permalink, selftext, created_utc, collected_at)
  VALUES
    (@post_id, @subreddit, @title, @author, @score, @upvote_ratio, @num_comments,
     @flair, @url, @permalink, @selftext, @created_utc, @collected_at)
`);

const updatePostStmt = () => getDb().prepare(`
  UPDATE posts
  SET score = @score, upvote_ratio = @upvote_ratio, num_comments = @num_comments
  WHERE post_id = @post_id
`);

export function insertPost(row: PostRow): boolean {
  const result = insertPostStmt().run(row);
  if (result.changes === 0) {
    // Post already exists — keep score/upvote_ratio/num_comments current
    // so the dashboard always reflects the latest Reddit data
    updatePostStmt().run({
      score:        row.score,
      upvote_ratio: row.upvote_ratio,
      num_comments: row.num_comments,
      post_id:      row.post_id,
    });
  }
  return result.changes > 0;
}

/** Return post_ids for posts created within the last N days. */
export function getPostIdsYoungerThan(days: number): string[] {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  return (getDb()
    .prepare(`SELECT post_id FROM posts WHERE created_utc > ? ORDER BY created_utc DESC`)
    .all(cutoff) as { post_id: string }[])
    .map(r => r.post_id);
}

export function getPostById(postId: string): PostRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM posts WHERE post_id = ?`)
    .get(postId) as PostRow | undefined;
}

export function getLastCollectedAt(): string | null {
  const row = getDb()
    .prepare(`SELECT MAX(collected_at) as ts FROM posts`)
    .get() as { ts: string | null };
  return row.ts;
}

export function getPostsBetween(from: string, to: string): PostRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM posts
      WHERE collected_at BETWEEN ? AND ?
      ORDER BY created_utc DESC
    `)
    .all(from, to) as PostRow[];
}

export function countPostsSince(since: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as n FROM posts WHERE collected_at >= ?`)
    .get(since) as { n: number };
  return row.n;
}

// ── Comments ───────────────────────────────────────────────────────────────────

export interface CommentRow {
  comment_id:  string;
  post_id:     string;
  parent_id:   string | null;
  author:      string | null;
  body:        string | null;
  score:       number | null;
  created_utc: number;
  collected_at: string;
}

const insertCommentStmt = () => getDb().prepare(`
  INSERT OR IGNORE INTO comments
    (comment_id, post_id, parent_id, author, body, score, created_utc, collected_at)
  VALUES
    (@comment_id, @post_id, @parent_id, @author, @body, @score, @created_utc, @collected_at)
`);

export function bulkInsertComments(rows: CommentRow[]): number {
  const stmt = insertCommentStmt();
  const insertMany = getDb().transaction((items: CommentRow[]) => {
    let inserted = 0;
    for (const row of items) {
      const result = stmt.run(row);
      inserted += result.changes;
    }
    return inserted;
  });
  return insertMany(rows) as number;
}

export function getCommentsByPost(postId: string): CommentRow[] {
  return getDb()
    .prepare(`SELECT * FROM comments WHERE post_id = ? ORDER BY created_utc ASC`)
    .all(postId) as CommentRow[];
}

/** Return IDs of posts that have no comments stored yet. */
export function getPostIdsWithoutComments(): string[] {
  const rows = getDb()
    .prepare(`
      SELECT post_id FROM posts
      WHERE post_id NOT IN (SELECT DISTINCT post_id FROM comments)
      ORDER BY created_utc DESC
    `)
    .all() as { post_id: string }[];
  return rows.map(r => r.post_id);
}

// ── Subreddit snapshots ────────────────────────────────────────────────────────

export interface SnapshotRow {
  id:           number;
  taken_at:     string;
  subscribers:  number | null;
  active_users: number | null;
}

export function insertSnapshot(subscribers: number, activeUsers: number): void {
  getDb()
    .prepare(`
      INSERT INTO subreddit_snapshots (taken_at, subscribers, active_users)
      VALUES (?, ?, ?)
    `)
    .run(new Date().toISOString(), subscribers, activeUsers);
}

export function getSnapshotsBetween(from: string, to: string): SnapshotRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM subreddit_snapshots
      WHERE taken_at BETWEEN ? AND ?
      ORDER BY taken_at ASC
    `)
    .all(from, to) as SnapshotRow[];
}

export function getAllSnapshots(): SnapshotRow[] {
  return getDb()
    .prepare(`SELECT * FROM subreddit_snapshots ORDER BY taken_at ASC`)
    .all() as SnapshotRow[];
}

// ── Posts (extended queries) ───────────────────────────────────────────────────

/** Posts created within the last N hours (0 = all time), ordered newest first. */
export function getPostsInWindow(windowHours: number, limit = 500): PostRow[] {
  if (!windowHours) {
    return getDb()
      .prepare(`SELECT * FROM posts ORDER BY created_utc DESC LIMIT ?`)
      .all(limit) as PostRow[];
  }
  const since = Math.floor(Date.now() / 1000) - windowHours * 3600;
  return getDb()
    .prepare(`
      SELECT * FROM posts
      WHERE created_utc >= ?
      ORDER BY created_utc DESC
      LIMIT ?
    `)
    .all(since, limit) as PostRow[];
}

// ── FTS5 search ────────────────────────────────────────────────────────────────

/**
 * Rebuild the FTS5 index from scratch using all existing posts and comments.
 * Called automatically on first startup after FTS support is added.
 */
export function rebuildContentFts(): void {
  getDb().exec(`
    DELETE FROM content_fts;
    INSERT INTO content_fts(text, post_id)
      SELECT title || ' ' || COALESCE(selftext, ''), post_id FROM posts;
    INSERT INTO content_fts(text, post_id)
      SELECT COALESCE(body, ''), post_id FROM comments
      WHERE body IS NOT NULL AND body != '';
  `);
}

/**
 * Search posts using FTS5 BM25 ranking across post text and comments.
 * Returns up to `limit` post_ids ranked by relevance.
 * windowHours = 0 means all time (no cutoff).
 */
export function searchPostsByFts(
  ftsQuery:    string,
  windowHours: number,
  limit:       number,
): string[] {
  if (!ftsQuery.trim()) return [];

  if (!windowHours) {
    // All time — no time filter needed
    return (
      getDb()
        .prepare(
          `SELECT post_id, MIN(bm25(content_fts)) AS score
           FROM content_fts
           WHERE content_fts MATCH ?
           GROUP BY post_id
           ORDER BY score
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as { post_id: string }[]
    ).map(r => r.post_id);
  }

  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  return (
    getDb()
      .prepare(
        `SELECT f.post_id, MIN(bm25(f)) AS score
         FROM content_fts f
         WHERE f MATCH ?
           AND f.post_id IN (SELECT post_id FROM posts WHERE created_utc >= ?)
         GROUP BY f.post_id
         ORDER BY score
         LIMIT ?`,
      )
      .all(ftsQuery, cutoff, limit) as { post_id: string }[]
  ).map(r => r.post_id);
}

export function countAllPosts(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as n FROM posts`)
    .get() as { n: number };
  return row.n;
}

export function countAllComments(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as n FROM comments`)
    .get() as { n: number };
  return row.n;
}

export function getLatestSnapshot(): SnapshotRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM subreddit_snapshots ORDER BY taken_at DESC LIMIT 1`)
    .get() as SnapshotRow | undefined;
}

export function getPostsPerDay(days = 30): { day: string; count: number }[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return getDb()
    .prepare(`
      SELECT date(collected_at) as day, COUNT(*) as count
      FROM posts
      WHERE collected_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `)
    .all(since) as { day: string; count: number }[];
}

// ── Sentiment reports ──────────────────────────────────────────────────────────

export interface SentimentRow {
  id:       number;
  taken_at: string;
  mood:     string | null;
  raw_json: string | null;
}

export function insertSentimentReport(mood: string, rawJson: string): void {
  getDb()
    .prepare(`INSERT INTO sentiment_reports (taken_at, mood, raw_json) VALUES (?, ?, ?)`)
    .run(new Date().toISOString(), mood, rawJson);
}

export function getSentimentReports(limit = 30): SentimentRow[] {
  return getDb()
    .prepare(`SELECT * FROM sentiment_reports ORDER BY taken_at DESC LIMIT ?`)
    .all(limit) as SentimentRow[];
}

export function getSentimentReportTrend(days: number): { date: string; mood_score: number }[] {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = getDb()
    .prepare(`SELECT taken_at, raw_json FROM sentiment_reports WHERE taken_at >= ? ORDER BY taken_at ASC`)
    .all(cutoff) as { taken_at: string; raw_json: string | null }[];
  return rows.flatMap(r => {
    if (!r.raw_json) return [];
    try {
      const parsed = JSON.parse(r.raw_json) as { mood_score?: number };
      if (typeof parsed.mood_score !== 'number') return [];
      return [{ date: r.taken_at.slice(0, 10), mood_score: parsed.mood_score }];
    } catch { return []; }
  });
}

// ── Chat jobs ──────────────────────────────────────────────────────────────────

export interface ChatJobRow {
  id:           string;
  created_at:   string;
  updated_at:   string;
  question:     string;
  window_hours: number;
  collect_cap:  number;
  status:       'queued' | 'running' | 'completed' | 'failed';
  answer:       string | null;
  collected:    number | null;
  analysed:     number | null;
  error:        string | null;
}

export function insertChatJob(row: Omit<ChatJobRow, 'answer' | 'collected' | 'analysed' | 'error'>): void {
  getDb()
    .prepare(`
      INSERT INTO chat_jobs (id, created_at, updated_at, question, window_hours, collect_cap, status)
      VALUES (@id, @created_at, @updated_at, @question, @window_hours, @collect_cap, @status)
    `)
    .run(row);
}

export function updateChatJob(id: string, fields: Partial<ChatJobRow>): void {
  const updates = Object.keys(fields)
    .map(k => `${k} = @${k}`)
    .join(', ');
  getDb()
    .prepare(`UPDATE chat_jobs SET ${updates}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: new Date().toISOString() });
}

export function getChatJob(id: string): ChatJobRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM chat_jobs WHERE id = ?`)
    .get(id) as ChatJobRow | undefined;
}

export function deleteChatJob(id: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM chat_jobs WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

export function getChatJobsPage(page: number, pageSize: number): { items: ChatJobRow[]; total: number } {
  const offset = (page - 1) * pageSize;
  const items = getDb()
    .prepare(`SELECT * FROM chat_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(pageSize, offset) as ChatJobRow[];
  const { n } = getDb()
    .prepare(`SELECT COUNT(*) as n FROM chat_jobs`)
    .get() as { n: number };
  return { items, total: n };
}
