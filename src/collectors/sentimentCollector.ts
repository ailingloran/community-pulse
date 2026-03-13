import { getDb, insertSentimentReport, getSentimentReports, PostRow, CommentRow, SentimentRow } from '../store/db';
import { config } from '../config';
import { logger } from '../logger';
import { analyseCommunityPulse, buildContentArray, PulseItem, PulseResult } from '../api/openai';

// ── Delta computation helpers ─────────────────────────────────────────────────

const DELTA_IGNORE = new Set([
  'players', 'player', 'about', 'their', 'with', 'from', 'this', 'that',
  'have', 'been', 'were', 'are', 'the', 'and', 'for', 'discussing',
  'mentioned', 'saying', 'said', 'game', 'community', 'reddit', 'they',
  'very', 'more', 'some', 'most', 'many', 'when', 'which', 'that',
  'posts', 'post', 'comments', 'comment', 'users', 'user',
]);

function extractSignificantWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4 && !DELTA_IGNORE.has(w)),
    ),
  ];
}

/**
 * For each pain_point in the current report, check if the same theme appeared
 * in any of the previous reports. Sets recurring=true and first_seen_days_ago
 * if at least 2 significant words overlap with a previous pain_point text.
 */
function markRecurring(currentItems: PulseItem[], previousReports: SentimentRow[]): void {
  const prevPains: { words: string[]; takenAt: string }[] = [];
  for (const report of previousReports) {
    if (!report.raw_json) continue;
    try {
      const parsed = JSON.parse(report.raw_json) as Partial<PulseResult>;
      if (!Array.isArray(parsed.pain_points)) continue;
      for (const pp of parsed.pain_points) {
        const text = typeof pp === 'string' ? pp : pp?.text;
        if (text) prevPains.push({ words: extractSignificantWords(text), takenAt: report.taken_at });
      }
    } catch { /* skip malformed */ }
  }

  for (const item of currentItems) {
    const currentWords = extractSignificantWords(item.text);
    let bestDaysAgo: number | null = null;

    for (const prev of prevPains) {
      const overlap = currentWords.filter(w => prev.words.includes(w)).length;
      if (overlap >= 2) {
        const daysAgo = Math.round((Date.now() - new Date(prev.takenAt).getTime()) / 86_400_000);
        if (bestDaysAgo === null || daysAgo > bestDaysAgo) bestDaysAgo = daysAgo;
      }
    }

    item.recurring = bestDaysAgo !== null;
    item.first_seen_days_ago = bestDaysAgo;
  }
}

/**
 * Build a citations map: 1-based content index → content string.
 *
 * Only stores a citation if the cited content contains at least one significant
 * word from the item's text. This filters out GPT hallucinated indices where
 * the cited content is unrelated to the topic it supposedly supports.
 */
function buildCitations(pulse: PulseResult, content: string[]): Record<number, string> {
  const citations: Record<number, string> = {};
  const allItems: PulseItem[] = [...pulse.topics, ...pulse.pain_points, ...pulse.positives];

  for (const item of allItems) {
    const itemWords = extractSignificantWords(item.text);
    const seenIdx = new Set<number>();

    for (const idx of item.msgs) {
      if (seenIdx.has(idx)) continue; // skip duplicate indices from GPT
      seenIdx.add(idx);

      if (idx < 1 || idx > content.length) {
        logger.warn(`[sentiment] Citation index ${idx} out of bounds (max ${content.length}) for item: "${item.text.slice(0, 50)}"`);
        continue;
      }

      const text = content[idx - 1]; // msgs are 1-based
      if (!text) continue;

      // Require at least 2 significant keyword matches to filter GPT hallucinations.
      const textLower = text.toLowerCase();
      const matchCount = itemWords.filter(w => textLower.includes(w)).length;
      if (itemWords.length === 0 || matchCount >= 2) {
        citations[idx] = text;
      }
    }
  }

  return citations;
}

// ── Main collector ─────────────────────────────────────────────────────────────

export async function collectSentiment(): Promise<void> {
  if (!config.openaiApiKey) {
    logger.warn('[sentiment] OPENAI_API_KEY not set — skipping');
    return;
  }

  const db = getDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const dayAgo = nowSec - 24 * 3600;

  // Get top posts from last 24h (by score, capped at 50)
  const posts = db
    .prepare(`
      SELECT * FROM posts
      WHERE created_utc >= ?
      ORDER BY score DESC
      LIMIT 50
    `)
    .all(dayAgo) as PostRow[];

  if (posts.length < 3) {
    logger.warn(`[sentiment] Only ${posts.length} posts in last 24h — skipping`);
    return;
  }

  // Load top comments for each post
  const commentsByPost = new Map<string, CommentRow[]>();
  for (const p of posts) {
    const comments = db
      .prepare(`
        SELECT * FROM comments
        WHERE post_id = ?
        ORDER BY score DESC
        LIMIT 10
      `)
      .all(p.post_id) as CommentRow[];
    commentsByPost.set(p.post_id, comments);
  }

  logger.info(`[sentiment] Analysing ${posts.length} posts with OpenAI...`);

  // Build flat numbered content array for GPT + citation mapping
  const content = buildContentArray(posts, commentsByPost, 5);

  try {
    const pulse = await analyseCommunityPulse(content);
    if (!pulse) {
      logger.error('[sentiment] OpenAI analysis returned null — skipping');
      return;
    }

    // Enrich: citations
    pulse.citations = buildCitations(pulse, content);

    // Enrich: recurring pain points (check against last 3 reports)
    const previousReports = getSentimentReports(3);
    markRecurring(pulse.pain_points, previousReports);

    insertSentimentReport(pulse.mood, JSON.stringify(pulse));
    logger.info(`[sentiment] Complete — mood score ${pulse.mood_score}/5: ${pulse.mood}`);
  } catch (err) {
    logger.error('[sentiment] Analysis failed:', err);
  }
}
