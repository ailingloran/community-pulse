import { randomUUID } from 'node:crypto';
import {
  insertChatJob,
  updateChatJob,
  getChatJob,
  deleteChatJob,
  getChatJobsPage,
  getPostsInWindow,
  getCommentsByPost,
  ChatJobRow,
} from '../store/db';
import { answerQuestion } from '../api/openai';
import { logger } from '../logger';

// Track which jobs are currently executing so we don't delete them mid-run
const activeJobs = new Set<string>();

export interface ChatJobResponse {
  jobId:      string;
  status:     ChatJobRow['status'];
  question?:  string;
  createdAt?: string;
  answer?:    string;
  collected?: number;
  analysed?:  number;
  error?:     string;
}

function toResponse(row: ChatJobRow): ChatJobResponse {
  return {
    jobId:     row.id,
    status:    row.status,
    question:  row.question,
    createdAt: row.created_at,
    ...(row.answer    != null ? { answer:    row.answer }    : {}),
    ...(row.collected != null ? { collected: row.collected } : {}),
    ...(row.analysed  != null ? { analysed:  row.analysed }  : {}),
    ...(row.error     != null ? { error:     row.error }     : {}),
  };
}

export function createChatJob(
  question:    string,
  windowHours: number,
  collectCap:  number,
): ChatJobResponse {
  const id  = randomUUID();
  const now = new Date().toISOString();

  insertChatJob({
    id,
    created_at:   now,
    updated_at:   now,
    question,
    window_hours: windowHours,
    collect_cap:  collectCap,
    status:       'queued',
  });

  queueChatJob(id);
  return { jobId: id, status: 'queued' };
}

export function getChatJobResponse(jobId: string): ChatJobResponse | null {
  const row = getChatJob(jobId);
  return row ? toResponse(row) : null;
}

export function getChatHistory(page: number, pageSize: number) {
  const { items, total } = getChatJobsPage(page, pageSize);
  return {
    items:      items.map(toResponse),
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
  };
}

export function removeChatJob(jobId: string): { ok: boolean; reason?: string } {
  const row = getChatJob(jobId);
  if (!row)                    return { ok: false, reason: 'not_found' };
  if (activeJobs.has(jobId))   return { ok: false, reason: 'still_running' };
  deleteChatJob(jobId);
  return { ok: true };
}

// ── Execution ─────────────────────────────────────────────────────────────────

function queueChatJob(jobId: string): void {
  activeJobs.add(jobId);
  setImmediate(() => runChatJob(jobId));
}

async function runChatJob(jobId: string): Promise<void> {
  const row = getChatJob(jobId);
  if (!row) { activeJobs.delete(jobId); return; }

  updateChatJob(jobId, { status: 'running' });

  try {
    // Fetch posts in the window (capped)
    const posts = getPostsInWindow(row.window_hours, row.collect_cap);

    // Load comments for each post
    const commentsByPost = new Map(
      posts.map(p => [p.post_id, getCommentsByPost(p.post_id)]),
    );

    logger.info(`[chatJob ${jobId}] ${posts.length} posts, asking OpenAI...`);

    const { answer, collected, analysed } = await answerQuestion(
      posts,
      commentsByPost,
      row.question,
    );

    updateChatJob(jobId, { status: 'completed', answer, collected, analysed });
    logger.info(`[chatJob ${jobId}] Completed (${analysed} items analysed)`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateChatJob(jobId, { status: 'failed', error });
    logger.error(`[chatJob ${jobId}] Failed:`, err);
  } finally {
    activeJobs.delete(jobId);
  }
}
