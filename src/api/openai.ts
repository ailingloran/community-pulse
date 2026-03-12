import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface PulseItem {
  text:                string;
  msgs:                number[];   // 1-based indices into the content array
  authors?:            number;     // unique Reddit usernames per topic
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

function getClient(): OpenAI {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');
  return new OpenAI({ apiKey: config.openaiApiKey });
}

// ── Content formatting ────────────────────────────────────────────────────────

/**
 * Flatten posts + top comments into a numbered string array.
 * Index i in the returned array corresponds to 1-based citation index i+1.
 */
export function buildContentArray(
  posts: Array<{ post_id: string; title: string; selftext?: string | null; flair?: string | null; score?: number | null; num_comments?: number | null; author?: string | null }>,
  commentsByPost: Map<string, Array<{ body?: string | null; author?: string | null; score?: number | null }>>,
  maxCommentsPerPost = 5,
): string[] {
  const content: string[] = [];

  for (const p of posts) {
    const head = [
      `POST: ${p.title}`,
      p.flair    ? `Flair: ${p.flair}` : null,
      `Score: ${p.score ?? 0} | Comments: ${p.num_comments ?? 0}`,
      p.selftext?.trim() ? `Body: ${p.selftext.slice(0, 300)}` : null,
    ].filter(Boolean).join(' | ');

    content.push(head);

    const comments = (commentsByPost.get(p.post_id) ?? [])
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, maxCommentsPerPost);

    for (const c of comments) {
      if (c.body?.trim()) {
        content.push(`COMMENT on "${p.title}": ${c.body.slice(0, 200)}`);
      }
    }
  }

  return content;
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

RULES:
- Group similar phrasings into one item — each item represents a distinct theme, not a list of individual posts
- Each item MUST have evidence from at least 2 different Reddit users (authors ≥ 2) before inclusion
  Exception: minority_insight may come from a single insightful post/comment
- Use prevalence signals in your text: "~N users discuss", "widely posted about", "several comments note"
- NEVER quote verbatim — describe, paraphrase, synthesise
- Focus on World of Warships gameplay, ships, balance, events, mechanics — not meta/subreddit discussion
- Keep each item under 20 words

SCHEMA — return ONLY valid JSON:
{
  "topics":      [{ "text": "string", "msgs": [1-based content indices], "authors": number }, ...],
  "pain_points": [{ "text": "string", "msgs": [1-based content indices], "authors": number }, ...],
  "positives":   [{ "text": "string", "msgs": [1-based content indices], "authors": number }, ...],
  "trending":    "string (single short phrase)",
  "mood_score":  number,
  "mood":        "string (1-sentence summary with tone)"
}

Counts: topics 3–5, pain_points 1–6, positives 1–5.
mood_score: 1=very negative, 2=negative, 3=neutral, 4=positive, 5=very positive.`;

/**
 * Analyse a flat, numbered content array (built by buildContentArray).
 * Returns the raw PulseResult; callers add citations and recurring flags.
 */
export async function analyseCommunityPulse(content: string[]): Promise<PulseResult | null> {
  if (!config.openaiApiKey) return null;

  const client = getClient();
  const numbered = content.map((line, i) => `[${i + 1}] ${line}`).join('\n');

  const userPrompt = `Below are ${content.length} numbered items from r/WorldOfWarships (posts and comments), 1-based index.\n\n${numbered}`;

  try {
    const response = await client.chat.completions.create({
      model:           'gpt-4o-mini',
      temperature:     0.3,
      max_tokens:      1600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    logger.debug('[openai] analyseCommunityPulse raw:', raw);

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
      topics:           normaliseItems(parsed.topics),
      pain_points:      normaliseItems(parsed.pain_points),
      positives:        normaliseItems(parsed.positives),
      trending:         typeof parsed.trending === 'string' ? parsed.trending : '',
      mood_score:       typeof parsed.mood_score === 'number' ? parsed.mood_score : 3,
      mood:             typeof parsed.mood === 'string' ? parsed.mood : '',
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
      `POST: ${p.title}\nFlair: ${p.flair ?? 'none'}\nScore: ${p.score ?? 0}\n${(p.selftext ?? '').slice(0, 200)}`,
    );
    for (const c of (commentsByPost.get(p.post_id) ?? [])) {
      items.push(`COMMENT on "${p.title}": ${(c.body ?? '').slice(0, 200)}`);
    }
  }

  const collected = items.length;
  const sampled = collected > MAX_ITEMS
    ? items.sort(() => Math.random() - 0.5).slice(0, MAX_ITEMS)
    : items;
  const analysed = sampled.length;

  const dataText = sampled.join('\n---\n');

  const systemMsg = `You are a community analyst for r/WorldOfWarships, a naval warfare game.
Use the posts and comments below to answer the question.
Be specific — cite post titles or comment details where relevant.
If the data is insufficient to answer confidently, say so.

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
    model:       'gpt-4o-mini',
    temperature: 0.4,
    max_tokens:  900,
    messages,
  });

  const answer = response.choices[0]?.message?.content ?? '(No response)';
  return { answer, collected, analysed };
}
