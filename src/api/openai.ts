import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface PulseItem {
  text:                string;
  msgs:                number[];   // 1-based indices into the content array
  authors?:            number;     // unique Reddit usernames per topic (verified post-GPT)
  recurring?:          boolean;
  first_seen_days_ago?: number | null;
}

export interface PulseResult {
  topics:      PulseItem[];
  pain_points: PulseItem[];
  positives:   PulseItem[];
  trending:    string;
  mood_score:  number;
  mood:        string;
  citations?:  Record<number, string>;
}

export interface ChatResult {
  answer:    string;
  collected: number;
  analysed:  number;
}

export interface SessionTurn {
  question: string;
  answer:   string;
}

/** Returned by buildContentArray — content plus a map for post-GPT author verification. */
export interface ContentArrayResult {
  content:       string[];
  /** 1-based content index → Reddit username (used to verify GPT's author counts) */
  authorByIndex: Map<number, string>;
}

function getClient(): OpenAI {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');
  return new OpenAI({ apiKey: config.openaiApiKey });
}

// ── Content formatting ────────────────────────────────────────────────────────

/**
 * Flatten posts + top comments into a numbered string array.
 * Each entry is prefixed with a unique "UserN:" label derived from the author.
 * The returned authorByIndex map lets callers verify GPT's author counts
 * after the fact by extracting UserN prefixes from the cited indices.
 *
 * Index i in content corresponds to 1-based citation index i+1.
 */
export function buildContentArray(
  posts: Array<{ post_id: string; title: string; selftext?: string | null; flair?: string | null; score?: number | null; num_comments?: number | null; author?: string | null }>,
  commentsByPost: Map<string, Array<{ body?: string | null; author?: string | null; score?: number | null }>>,
  maxCommentsPerPost = 8,
): ContentArrayResult {
  // First pass: collect all unique authors and assign UserN labels
  const userLabelMap = new Map<string, string>(); // username → UserN
  let labelCounter = 0;

  const getLabel = (author: string | null | undefined): string => {
    if (!author) return 'UserX';
    if (!userLabelMap.has(author)) {
      labelCounter++;
      userLabelMap.set(author, `User${labelCounter}`);
    }
    return userLabelMap.get(author)!;
  };

  // Pre-scan all authors so labels are assigned in a consistent order
  for (const p of posts) {
    getLabel(p.author);
    for (const c of (commentsByPost.get(p.post_id) ?? [])) {
      getLabel(c.author);
    }
  }

  const content: string[] = [];
  const authorByIndex = new Map<number, string>(); // 1-based → username

  for (const p of posts) {
    const label = getLabel(p.author);
    const head = [
      `POST: ${p.title}`,
      p.flair    ? `Flair: ${p.flair}` : null,
      `Score: ${p.score ?? 0} | Comments: ${p.num_comments ?? 0}`,
      p.selftext?.trim() ? `Body: ${p.selftext.slice(0, 600)}` : null,
    ].filter(Boolean).join(' | ');

    const idx = content.length + 1; // 1-based
    content.push(`${label}: ${head}`);
    if (p.author) authorByIndex.set(idx, p.author);

    const comments = (commentsByPost.get(p.post_id) ?? [])
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, maxCommentsPerPost);

    for (const c of comments) {
      if (c.body?.trim()) {
        const commentLabel = getLabel(c.author);
        const commentIdx = content.length + 1;
        content.push(`${commentLabel}: COMMENT on "${p.title}" | ${c.body.slice(0, 400)}`);
        if (c.author) authorByIndex.set(commentIdx, c.author);
      }
    }
  }

  return { content, authorByIndex };
}

// ── Keyword extraction ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'what', 'how', 'when', 'where', 'why', 'who', 'which', 'are', 'is',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been',
  'they', 'their', 'about', 'would', 'could', 'should', 'were', 'will',
  'can', 'did', 'does', 'into', 'your', 'you', 'our', 'more', 'like',
  'than', 'think', 'players', 'player', 'say', 'says', 'said', 'feel',
  'tell', 'give', 'make', 'take', 'want', 'need', 'there',
  'some', 'other', 'most', 'much', 'many', 'very', 'just', 'also',
  'only', 'but', 'not', 'all', 'any', 'its', 'it', 'be', 'has', 'do',
  'an', 'we', 'in', 'on', 'to', 'of', 'at', 'by', 'posts', 'post',
  'reddit', 'comments', 'comment', 'subreddit', 'community',
]);

function basicKeywords(question: string): string[] {
  return [...new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w)),
  )];
}

function sanitizeFtsKeywords(words: string[]): string {
  return words
    .map(k => k.replace(/["*()\-^:]/g, ' ').trim())
    .filter(k => k.length >= 2)
    .join(' OR ');
}

export async function extractKeywordsForSearch(question: string): Promise<string> {
  const fallback = sanitizeFtsKeywords(basicKeywords(question));
  if (!config.openaiApiKey) return fallback;

  try {
    const client = getClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 80,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a search query builder for a World of Warships subreddit database. ' +
            'Extract the most important search terms from the user\'s question. ' +
            'Return ONLY a JSON object: {"keywords": ["word1", "word2", ...]}. ' +
            'Include specific ship names, game mechanics, modes, and relevant nouns. ' +
            '3-8 keywords, no stop words, no punctuation inside keywords.',
        },
        { role: 'user', content: question },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { keywords?: unknown };
    const kws = Array.isArray(parsed.keywords)
      ? (parsed.keywords as unknown[]).filter((k): k is string => typeof k === 'string')
      : [];

    if (kws.length === 0) return fallback;
    return sanitizeFtsKeywords(kws);
  } catch {
    return fallback;
  }
}

// ── Sentiment analysis ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a community analyst for r/WorldOfWarships, a naval warfare game subreddit.
Your task: analyse today's posts and comments to surface what the community is actually discussing.

Each post and comment is prefixed with a unique author label (User1, User2, ...) that identifies who wrote it.
Use these labels to track which themes come from multiple distinct users.

RULES:
- Group similar phrasings into one item — each item represents a distinct theme, not a list of individual posts
- Only include an item if you can cite evidence from at least 2 different UserN labels
- Use prevalence signals in your text: "~N users discuss", "widely posted about", "several comments note"
- NEVER quote verbatim — describe, paraphrase, synthesise
- Focus on World of Warships gameplay, ships, balance, events, mechanics — not meta/subreddit discussion
- Be specific and analytical — name the actual ships, mechanics, events, and issues players raised
- Each item's "text" MUST be 2–4 sentences: start with what the theme is, then explain why players care or what specifically they said, and include any concrete details (ship names, numbers, patch context). One-liners are not acceptable.
- The "mood" field must be 2–3 sentences covering the overall atmosphere, what is driving it, and any notable contrasts between positive and negative currents.
- The "trending" field should be a descriptive phrase that includes why the topic is gaining traction — not just a bare noun.

SCHEMA — return ONLY valid JSON:
{
  "topics":      [{ "text": "string (2-4 sentences)", "msgs": [1-based content indices] }, ...],
  "pain_points": [{ "text": "string (2-4 sentences)", "msgs": [1-based content indices] }, ...],
  "positives":   [{ "text": "string (2-4 sentences)", "msgs": [1-based content indices] }, ...],
  "trending":    "string (descriptive phrase with context, not a bare topic name)",
  "mood_score":  number,
  "mood":        "string (2-3 sentences)"
}

Counts: topics 3–5, pain_points 1–6, positives 1–5.
mood_score: 1=very negative, 2=negative, 3=neutral, 4=positive, 5=very positive.`;

/**
 * Analyse a flat, numbered content array (built by buildContentArray).
 * Returns the raw PulseResult; callers add citations, verify author counts,
 * and add recurring flags.
 */
export async function analyseCommunityPulse(content: string[]): Promise<PulseResult | null> {
  if (!config.openaiApiKey) return null;

  const client = getClient();
  const numbered = content.map((line, i) => `[${i + 1}] ${line}`).join('\n');

  const userPrompt = `Below are ${content.length} numbered items from r/WorldOfWarships (posts and comments), 1-based index.\n\n${numbered}`;

  try {
    const response = await client.chat.completions.create({
      model:                 'gpt-5.1',
      max_completion_tokens: 16000,
      response_format:       { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
    });

    const finish = response.choices[0]?.finish_reason;
    logger.info(`[openai] analyseCommunityPulse finish_reason=${finish}`);

    const raw = response.choices[0]?.message?.content ?? '';
    if (!raw) {
      logger.error('[openai] analyseCommunityPulse: empty response from model');
      return null;
    }

    logger.info('[openai] analyseCommunityPulse raw:', raw.slice(0, 500));

    const parsed = JSON.parse(raw) as Partial<PulseResult>;

    // Normalise: ensure all array fields are arrays of PulseItem
    const normaliseItems = (arr: unknown): PulseItem[] => {
      if (!Array.isArray(arr)) return [];
      return arr.map(item => typeof item === 'string'
        ? { text: item, msgs: [], authors: undefined }
        : { text: String(item?.text ?? ''), msgs: Array.isArray(item?.msgs) ? item.msgs as number[] : [], authors: item?.authors as number | undefined },
      );
    };

    return {
      topics:      normaliseItems(parsed.topics),
      pain_points: normaliseItems(parsed.pain_points),
      positives:   normaliseItems(parsed.positives),
      trending:    typeof parsed.trending === 'string' ? parsed.trending : '',
      mood_score:  typeof parsed.mood_score === 'number' ? parsed.mood_score : 3,
      mood:        typeof parsed.mood === 'string' ? parsed.mood : '',
    };
  } catch (err) {
    logger.error('[openai] analyseCommunityPulse failed:', err);
    return null;
  }
}

// ── Question answering ────────────────────────────────────────────────────────

const MAX_ITEMS = 4500;

export async function answerQuestion(
  posts: Array<{ post_id: string; title: string; flair?: string | null; score?: number | null; selftext?: string | null }>,
  commentsByPost: Map<string, Array<{ body?: string | null }>>,
  question: string,
  priorTurns: SessionTurn[] = [],
): Promise<ChatResult> {
  const client = getClient();

  // Flatten posts + comments into items for sampling
  const items: string[] = [];
  for (const p of posts) {
    items.push(
      `POST: ${p.title}\nFlair: ${p.flair ?? 'none'}\nScore: ${p.score ?? 0}\n${(p.selftext ?? '').slice(0, 300)}`,
    );
    for (const c of (commentsByPost.get(p.post_id) ?? [])) {
      items.push(`COMMENT on "${p.title}": ${(c.body ?? '').slice(0, 300)}`);
    }
  }

  const collected = items.length;
  const sampled = collected > MAX_ITEMS
    ? items.sort(() => Math.random() - 0.5).slice(0, MAX_ITEMS)
    : items;
  const analysed = sampled.length;

  const dataText = sampled.join('\n---\n');

  const systemMsg = `You are a community analyst for r/WorldOfWarships, a naval warfare game subreddit. Answer questions about what players are discussing, based strictly on the posts and comments provided.

RESPONSE RULES — follow all of these without exception:
- Answer directly. Do not restate the question or explain what you are about to do.
- Do not reference post/comment indices or say things like "post [1]" or "based on these N posts".
- Do not quote players verbatim.
- Do not add closing remarks like "let me know if you want more detail" or "I can refine this".
- Do not hedge with "from this sample" or "based only on the provided data" — just give the answer.
- If the data is genuinely insufficient, say so in one short sentence, then give whatever partial insight you can.
- Name specific ships, mechanics, game modes, and post titles where relevant — be concrete.
- Keep answers focused and proportionate to the question.
- FORMAT RULES (mandatory):
  - Write in paragraphs by default.
  - For top-level lists use "1." "2." "3." with a bold title: e.g. "1. **Title here**" then a new line.
  - For sub-points under a numbered item, use "- " bullet lines (never nest numbers inside numbers).
  - Bold (**text**) is only for titles or key terms, not whole sentences.

Data:
${dataText}`;

  // Build message history: system + prior turns + current question
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemMsg },
    ...priorTurns.flatMap(t => ([
      { role: 'user' as const,      content: t.question },
      { role: 'assistant' as const, content: t.answer   },
    ])),
    { role: 'user', content: question },
  ];

  const response = await client.chat.completions.create({
    model:       'gpt-4o',
    temperature: 0.3,
    max_tokens:  2000,
    messages,
  });

  const answer = response.choices[0]?.message?.content ?? '(No response)';
  return { answer, collected, analysed };
}
