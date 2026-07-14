import { err, errorMessage, ok } from '@sailor/core';
import { tool } from 'ai';
import { z } from 'zod';

/**
 * The agent chooses these URLs, and the agent is steered by text it read on the
 * internet. Treat every fetch as attacker-influenced: without this guard,
 * "fetch http://169.254.169.254/latest/meta-data/iam/..." is a cloud-credential
 * exfiltration primitive, and http://localhost:5432 is our own database.
 */
const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '::1', 'metadata.google.internal']);

const PRIVATE_IPV4 =
  /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Refusing to fetch a ${url.protocol} URL; only http and https are allowed`);
  }

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error(`Refusing to fetch a private address: ${host}`);
  }
  if (PRIVATE_IPV4.test(host) || host.startsWith('[fd') || host.startsWith('[fe80')) {
    throw new Error(`Refusing to fetch a private address: ${host}`);
  }

  return url;
}

/** Strip tags and collapse whitespace. Not a parser — just enough to read a JD. */
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_CHARS = 20_000;

export function researchTools() {
  return {
    fetch_url: tool({
      description:
        'Fetch a public web page as text. Use this to read the actual job posting or the ' +
        "company's engineering blog, rather than relying on what you remember about them.",
      inputSchema: z.object({
        url: z.string().describe('Full URL, including https://'),
      }),
      async execute({ url }) {
        let target: URL;
        try {
          target = assertPublicUrl(url);
        } catch (cause) {
          return err(errorMessage(cause), 'Only public http(s) pages can be fetched.');
        }

        try {
          const res = await fetch(target, {
            headers: {
              'user-agent': 'Sailor/0.1 (resume tailoring assistant)',
            },
            signal: AbortSignal.timeout(15_000),
            redirect: 'follow',
          });

          if (!res.ok) {
            return err(
              `${target.host} returned ${res.status} ${res.statusText}`,
              res.status === 403 || res.status === 429
                ? 'The site is blocking automated access. Ask the user to paste the text instead.'
                : 'Check the URL, or ask the user to paste the content.',
            );
          }

          const text = extractText(await res.text());
          if (text.length < 50) {
            return err(
              `${target.host} returned almost no readable text.`,
              'It is probably a JavaScript-rendered page. Ask the user to paste the posting.',
            );
          }

          return ok({
            url: target.toString(),
            truncated: text.length > MAX_CHARS,
            content: text.slice(0, MAX_CHARS),
          });
        } catch (cause) {
          return err(
            `Could not fetch ${target.host}: ${errorMessage(cause)}`,
            'Ask the user to paste the content instead.',
          );
        }
      },
    }),

    web_search: tool({
      description:
        'Search the web. Use it to find a job posting, or to check what a company actually ' +
        'values (their tech blog, their engineering principles) before you tailor wording to them.',
      inputSchema: z.object({
        query: z.string().min(3),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      async execute({ query, limit }) {
        const exaKey = process.env.EXA_API_KEY;
        const braveKey = process.env.BRAVE_SEARCH_API_KEY;

        if (exaKey) return searchExa(query, limit, exaKey);
        if (braveKey) return searchBrave(query, limit, braveKey);

        return err(
          'Web search is not configured on this server.',
          'Work from what the user gives you. If you need the job description, ask them to ' +
            'paste it or give you a URL you can fetch_url.',
        );
      },
    }),
  };
}

type SearchHit = { title: string; url: string; snippet: string };

async function searchExa(query: string, limit: number, apiKey: string) {
  try {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        query,
        numResults: limit,
        contents: { text: { maxCharacters: 1200 } },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return err(`Exa search failed (${res.status}): ${await res.text()}`);

    const json = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; text?: string }>;
    };

    const results: SearchHit[] = (json.results ?? []).map((r) => ({
      title: r.title ?? '(untitled)',
      url: r.url ?? '',
      snippet: (r.text ?? '').slice(0, 1200),
    }));

    return results.length > 0
      ? ok({ provider: 'exa', results })
      : err('No results.', 'Try a broader query.');
  } catch (cause) {
    return err(`Exa search failed: ${errorMessage(cause)}`);
  }
}

async function searchBrave(query: string, limit: number, apiKey: string) {
  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));

    const res = await fetch(url, {
      headers: { accept: 'application/json', 'x-subscription-token': apiKey },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return err(`Brave search failed (${res.status}): ${await res.text()}`);

    const json = (await res.json()) as {
      web?: {
        results?: Array<{ title?: string; url?: string; description?: string }>;
      };
    };

    const results: SearchHit[] = (json.web?.results ?? []).map((r) => ({
      title: r.title ?? '(untitled)',
      url: r.url ?? '',
      snippet: r.description ?? '',
    }));

    return results.length > 0
      ? ok({ provider: 'brave', results })
      : err('No results.', 'Try a broader query.');
  } catch (cause) {
    return err(`Brave search failed: ${errorMessage(cause)}`);
  }
}
