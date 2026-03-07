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

    CREATE INDEX IF NOT EXISTS idx_posts_created   ON posts    (created_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_flair      ON posts    (flair);
    CREATE INDEX IF NOT EXISTS idx_comments_post    ON comments (post_id);
    CREATE INDEX IF NOT EXISTS idx_comments_created ON comments (created_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_time   ON subreddit_snapshots (taken_at DESC);
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

export function getPostsBetween(from: string, to: string): PostRow[] {
  return getDb()
    .prepare(`
      SELECT * FROM posts
      WHERE collected_at BETWEEN ? AND ?
      ORDER BY created_utc ASC
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
