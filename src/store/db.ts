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
  `);

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

export function insertPost(row: PostRow): boolean {
  const result = insertPostStmt().run(row);
  return result.changes > 0;
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

/** Posts created within the last N hours, ordered newest first. */
export function getPostsInWindow(windowHours: number, limit = 500): PostRow[] {
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
