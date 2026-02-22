// ============================================================
//  Web Tools — search, fetch, and download
//  No external API keys required
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const { getWorkspace } = require('../utils/workspace');

/**
 * Strip HTML tags and decode common entities, collapse whitespace.
 */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate text to a max length, appending "..." if truncated.
 */
function truncate(text, max = 8000) {
  if (text.length <= max) return text;
  return text.substring(0, max) + '\n\n... (truncated)';
}

// ============================================================
//  Tool definitions
// ============================================================

const tools = [
  // ----------------------------------------------------------
  //  web_search — DuckDuckGo search
  // ----------------------------------------------------------
  {
    name: 'web_search',
    description:
      'Search the web using DuckDuckGo. Returns a list of results with titles, URLs, and snippets. ' +
      'Useful for finding documentation, looking up error messages, checking package info, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default 8, max 20)'
        }
      },
      required: ['query']
    },
    handler: async (args) => {
      const query = args.query;
      const maxResults = Math.min(args.max_results || 8, 20);

      try {
        // Use DuckDuckGo HTML endpoint (not lite — lite triggers bot detection)
        const params = new URLSearchParams({ q: query });
        const resp = await fetch('https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          body: params.toString(),
          signal: AbortSignal.timeout(15000)
        });

        if (!resp.ok) {
          return { error: `Search request failed: HTTP ${resp.status}` };
        }

        const html = await resp.text();

        // Parse results — DuckDuckGo HTML uses class="result__a" for links and class="result__snippet" for snippets
        const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

        const links = [];
        let match;
        while ((match = linkRegex.exec(html)) !== null) {
          links.push({
            url: match[1],
            title: stripHtml(match[2])
          });
        }

        const snippets = [];
        while ((match = snippetRegex.exec(html)) !== null) {
          snippets.push(stripHtml(match[1]));
        }

        const results = [];
        for (let i = 0; i < Math.min(links.length, maxResults); i++) {
          results.push({
            title: links[i].title,
            url: links[i].url,
            snippet: snippets[i] || ''
          });
        }

        if (results.length === 0) {
          return { results: [], message: 'No results found for this query.' };
        }

        return { results, result_count: results.length };
      } catch (err) {
        if (err.name === 'TimeoutError') {
          return { error: 'Search request timed out after 15 seconds.' };
        }
        return { error: `Search failed: ${err.message}` };
      }
    }
  },

  // ----------------------------------------------------------
  //  web_fetch — fetch a URL and return text content
  // ----------------------------------------------------------
  {
    name: 'web_fetch',
    description:
      'Fetch a web page and return its text content. Strips HTML tags for readability. ' +
      'Useful for reading documentation pages, README files, API docs, blog posts, etc. ' +
      'NOTE: For GitHub issues/PRs, prefer github_get_issue or github_get_pr instead — they return full untruncated content via the API.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch'
        },
        max_length: {
          type: 'number',
          description: 'Maximum character length of returned content (default 50000, max 100000)'
        }
      },
      required: ['url']
    },
    handler: async (args) => {
      const url = args.url;
      const maxLength = Math.min(args.max_length || 50000, 100000);

      // Basic URL validation
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return { error: 'Only HTTP and HTTPS URLs are supported.' };
        }
      } catch {
        return { error: 'Invalid URL format.' };
      }

      try {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'CodeBot/2.0 (Discord coding assistant)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7'
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000)
        });

        if (!resp.ok) {
          return { error: `HTTP ${resp.status} ${resp.statusText}` };
        }

        const contentType = resp.headers.get('content-type') || '';
        const body = await resp.text();

        // If it's plain text, JSON, or markdown, return as-is
        if (contentType.includes('text/plain') ||
            contentType.includes('application/json') ||
            contentType.includes('text/markdown')) {
          return {
            url,
            content_type: contentType.split(';')[0],
            content: truncate(body, maxLength)
          };
        }

        // For HTML, strip tags
        const text = stripHtml(body);
        return {
          url,
          content_type: contentType.split(';')[0],
          content: truncate(text, maxLength)
        };
      } catch (err) {
        if (err.name === 'TimeoutError') {
          return { error: 'Request timed out after 15 seconds.' };
        }
        return { error: `Fetch failed: ${err.message}` };
      }
    }
  },

  // ----------------------------------------------------------
  //  web_download — download large files to workspace/scratch
  // ----------------------------------------------------------
  {
    name: 'web_download',
    description:
      'Download a file from a URL to the workspace for analysis. Use this for large files that web_fetch truncates (log files, data dumps, etc). ' +
      'After downloading, use repo_read with line ranges or shell to examine the contents.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to download' },
        repo: { type: 'string', description: 'Repository (owner/repo) — file saved to this workspace. If omitted, saved to scratch/downloads.' },
        filename: { type: 'string', description: 'Filename to save as (default: derived from URL)' }
      },
      required: ['url']
    },
    handler: async (args, context) => {
      const url = args.url;

      // Validate URL
      let parsed;
      try {
        parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return { error: 'Only HTTP and HTTPS URLs are supported.' };
        }
      } catch {
        return { error: 'Invalid URL format.' };
      }

      // Determine save directory
      let saveDir;
      if (args.repo && context && context.userId) {
        const [owner, repo] = args.repo.split('/');
        if (!owner || !repo) return { error: 'Invalid repo format. Expected "owner/repo".' };
        saveDir = getWorkspace(context.userId, owner, repo);
      } else {
        saveDir = path.join(config.scratchDir, 'downloads');
      }
      fs.mkdirSync(saveDir, { recursive: true });

      // Sanitize filename
      let filename = args.filename;
      if (!filename) {
        // Derive from URL path
        const urlPath = parsed.pathname.split('/').pop() || 'downloaded-file';
        filename = urlPath;
      }
      // Strip path components, limit to safe characters
      filename = filename.replace(/[/\\]/g, '').replace(/[^a-zA-Z0-9._\-]/g, '_');
      if (!filename || filename === '.' || filename === '..') {
        filename = 'downloaded-file';
      }
      // Limit filename length
      if (filename.length > 200) {
        const ext = path.extname(filename);
        filename = filename.substring(0, 200 - ext.length) + ext;
      }

      const savePath = path.join(saveDir, filename);

      try {
        const resp = await fetch(url, {
          headers: {
            'User-Agent': 'CodeBot/2.0 (Discord coding assistant)'
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(60000)
        });

        if (!resp.ok) {
          return { error: `HTTP ${resp.status} ${resp.statusText}` };
        }

        const contentType = resp.headers.get('content-type') || 'unknown';

        // Stream to buffer, enforce 50MB limit
        const maxBytes = 50 * 1024 * 1024;
        const chunks = [];
        let totalBytes = 0;

        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          if (totalBytes > maxBytes) {
            reader.cancel();
            return { error: `File exceeds 50MB limit (received ${(totalBytes / 1024 / 1024).toFixed(1)}MB so far). Aborting.` };
          }
          chunks.push(value);
        }

        // Write to disk
        const buffer = Buffer.concat(chunks);
        fs.writeFileSync(savePath, buffer);

        return JSON.stringify({
          path: savePath,
          filename,
          sizeBytes: buffer.length,
          sizeMB: (buffer.length / (1024 * 1024)).toFixed(2),
          contentType: contentType.split(';')[0],
          message: `Downloaded ${(buffer.length / 1024).toFixed(1)}KB to ${savePath}. Use repo_read or shell to examine contents.`
        });
      } catch (err) {
        if (err.name === 'TimeoutError') {
          return { error: 'Download timed out after 60 seconds.' };
        }
        return { error: `Download failed: ${err.message}` };
      }
    }
  }
];

module.exports = { tools };
