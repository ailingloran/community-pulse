import OpenAI from 'openai';
import { config } from '../config';
import { logger } from '../logger';
import { PostRow, CommentRow } from '../store/db';

export interface PulseResult {
  topics:      string[];   // up to 5, each with a 1-sentence explanation
  pain_points: string[];   // 1–4 main complaints
  positives:   string[];   // 1–3 positive highlights
  trending:    string;     // single short phrase
  mood_score:  number;     // 1 (very negative) – 5 (very positive)
  mood:        string;     // 1-sentence summary with tone
}

export interface ChatResult {
  answer:    string;
  collected: number;
  analysed:  number;
}

function getClient(): OpenAI {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');
  return new OpenAI({ apiKey: config.openaiApiKey });
}

function formatPostsForPrompt(
  posts: PostRow[],
  commentsByPost: Map<string, CommentRow[]>,
  maxComments = 5,
): string {
  return posts.map(p => {
    const comments = (commentsByPost.get(p.post_id) ?? [])
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, maxComments);

    const body = p.selftext ? p.selftext.slice(0, 300) : '';
    const commentLines = comments
      .map(c => `  - ${(c.body ?? '').slice(0, 150)} (score: ${c.score ?? 0})`)
      .join('\n');

    return [
      `POST: ${p.title}`,
      p.flair    ? `Flair: ${p.flair}` : null,
      `Score: ${p.score ?? 0} | Comments: ${p.num_comments ?? 0}`,
      body       ? `Body: ${body}` : null,
      commentLines ? `Top comments:\n${commentLines}` : null,
      '---',
    ].filter(Boolean).join('\n');
  }).join('\n');
}

// ── Sentiment analysis ─────────────────────────────────────────────────────────

export async function analyseCommunityPulse(
  posts: PostRow[],
  commentsByPost: Map<string, CommentRow[]>,
): Promise<PulseResult> {
  const client = getClient();
  const text = formatPostsForPrompt(posts, commentsByPost, 5);

  const prompt = `You are analysing the r/WorldOfWarships subreddit for community sentiment.
Below are posts and top comments from the last 24 hours.
Return ONLY valid JSON matching this exact schema:
{
  "topics":      ["string (topic + 1-sentence explanation)", ...],
  "pain_points": ["string", ...],
  "positives":   ["string", ...],
  "trending":    "string",
  "mood_score":  number,
  "mood":        "string"
}

Subreddit content:
${text}`;

  const response = await client.chat.completions.create({
    model:           'gpt-4o-mini',
    temperature:     0.3,
    max_tokens:      700,
    response_format: { type: 'json_object' },
    messages:        [{ role: 'user', content: prompt }],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  logger.debug('[openai] analyseCommunityPulse raw:', raw);
  return JSON.parse(raw) as PulseResult;
}

// ── Question answering ────────────────────────────────────────────────────────

const MAX_ITEMS = 4500;

export async function answerQuestion(
  posts: PostRow[],
  commentsByPost: Map<string, CommentRow[]>,
  question: string,
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

  const prompt = `You are a community analyst for r/WorldOfWarships, a naval warfare game.
Use the posts and comments below to answer the question.
Be specific — cite post titles or comment details where relevant.
If the data is insufficient to answer confidently, say so.

Question: ${question}

Data:
${dataText}`;

  const response = await client.chat.completions.create({
    model:       'gpt-4o-mini',
    temperature: 0.4,
    max_tokens:  800,
    messages:    [{ role: 'user', content: prompt }],
  });

  const answer = response.choices[0]?.message?.content ?? '(No response)';
  return { answer, collected, analysed };
}
