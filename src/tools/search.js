import { config } from '../utils/config.js';
import * as cheerio from 'cheerio';

// --- Tool definitions ---

export const toolDefinitions = [
  {
    name: 'web_search',
    description: 'Search the web using Brave Search API. Returns titles, URLs, and snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        count: { type: 'number', description: 'Number of results (max 20). Default: 5.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and extract its text content. Converts HTML to readable text.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
        max_length: { type: 'number', description: 'Max characters to return. Default: 10000.' },
      },
      required: ['url'],
    },
  },
];

// --- Tool handlers ---

export async function web_search({ query, count = 5 }) {
  if (!config.braveApiKey) {
    throw new Error('BRAVE_API_KEY is not configured. Web search is unavailable.');
  }

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(count, 20)),
  });

  const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': config.braveApiKey,
    },
  });

  if (!resp.ok) {
    throw new Error(`Brave Search API error: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  const results = (data.web?.results || []).map(r => ({
    title: r.title,
    url: r.url,
    description: r.description,
  }));

  return {
    query,
    result_count: results.length,
    results,
  };
}

export async function web_fetch({ url, max_length = 10000 }) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ClaudeDiscordBot/1.0)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  const contentType = resp.headers.get('content-type') || '';

  // If it's not HTML, return raw text
  if (!contentType.includes('html')) {
    const text = await resp.text();
    return {
      url,
      content_type: contentType,
      content: text.slice(0, max_length),
      truncated: text.length > max_length,
    };
  }

  // Parse HTML and extract text content
  const html = await resp.text();
  const $ = cheerio.load(html);

  // Remove non-content elements
  $('script, style, nav, header, footer, iframe, noscript, svg').remove();

  // Extract title
  const title = $('title').text().trim();

  // Try to find main content area
  let content = '';
  const mainSelectors = ['article', 'main', '[role="main"]', '.content', '.post', '.entry'];
  for (const sel of mainSelectors) {
    const el = $(sel);
    if (el.length) {
      content = el.text();
      break;
    }
  }

  // Fallback to body
  if (!content) {
    content = $('body').text();
  }

  // Clean up whitespace
  content = content.replace(/\s+/g, ' ').trim();

  return {
    url,
    title,
    content: content.slice(0, max_length),
    truncated: content.length > max_length,
  };
}
