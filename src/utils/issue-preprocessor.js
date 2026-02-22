// ============================================================
//  Issue Pre-Processor — extract attachments, classify, download
//  Zero tokens: all work is programmatic
// ============================================================

const fs = require('fs');
const path = require('path');
const config = require('./config');

// ── Attachment URL patterns ─────────────────────────────────

const ATTACHMENT_PATTERNS = [
  // Pattern A: Modern image uploads  — github.com/user-attachments/assets/{UUID}
  /https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/gi,

  // Pattern B: Modern file uploads   — github.com/user-attachments/files/{ID}/{filename}
  /https:\/\/github\.com\/user-attachments\/files\/\d+\/[^\s)"\]]+/gi,

  // Pattern C: Legacy user images    — user-images.githubusercontent.com/{id}/{uuid}.ext
  /https:\/\/user-images\.githubusercontent\.com\/\d+\/[^\s)"\]]+/gi,

  // Pattern D: Private repo images   — private-user-images.githubusercontent.com/...
  /https:\/\/private-user-images\.githubusercontent\.com\/[^\s)"\]]+/gi,

  // Pattern E: Very old uploads      — cloud.githubusercontent.com/assets/...
  /https:\/\/cloud\.githubusercontent\.com\/assets\/[^\s)"\]]+/gi,

  // Pattern F: Proxied external      — camo.githubusercontent.com/...
  /https:\/\/camo\.githubusercontent\.com\/[^\s)"\]]+/gi,

  // Pattern G: Transitional          — github.com/{owner}/{repo}/assets/{id}/{uuid}
  /https:\/\/github\.com\/[^/]+\/[^/]+\/assets\/\d+\/[^\s)"\]]+/gi,
];

// External paste services
const PASTE_PATTERNS = [
  /https:\/\/gist\.github\.com\/[^\s)"\]]+/gi,
  /https:\/\/pastebin\.com\/[^\s)"\]]+/gi,
  /https:\/\/hastebin\.com\/[^\s)"\]]+/gi,
];

// ── File type classification ────────────────────────────────

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const LOG_EXTENSIONS = new Set(['.log', '.txt', '.out', '.err', '.trace']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.tar.gz']);
const CODE_EXTENSIONS = new Set(['.lua', '.js', '.ts', '.py', '.java', '.xml', '.json', '.yaml', '.yml', '.cfg', '.ini']);

function classifyUrl(url, markdownContext) {
  // Check markdown context first — images embedded with ![alt](url)
  if (markdownContext === 'image') return 'image';

  // Try to extract extension from URL
  const urlPath = new URL(url).pathname;
  const filename = urlPath.split('/').pop() || '';
  const ext = path.extname(filename).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (LOG_EXTENSIONS.has(ext)) return 'log';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive';
  if (CODE_EXTENSIONS.has(ext)) return 'code';

  // Heuristic: user-attachments/assets/ without extension are usually images
  if (/github\.com\/user-attachments\/assets\//.test(url) && !ext) return 'image';

  // Heuristic: user-attachments/files/ are usually logs/text
  if (/github\.com\/user-attachments\/files\//.test(url)) return 'log';

  return 'unknown';
}

function extractFilename(url) {
  try {
    const urlPath = new URL(url).pathname;
    const segments = urlPath.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || 'attachment';
    // Sanitize
    return last.replace(/[^a-zA-Z0-9._\-]/g, '_').substring(0, 200);
  } catch {
    return 'attachment';
  }
}

// ── Extract all attachment URLs from markdown text ───────────

function extractAttachments(text) {
  const attachments = new Map(); // url → { url, category, filename, context }

  if (!text) return [];

  // First pass: find image-embedded URLs  — ![alt](url)
  const imageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    const url = match[1].trim();
    if (!attachments.has(url)) {
      attachments.set(url, {
        url,
        category: classifyUrl(url, 'image'),
        filename: extractFilename(url),
        context: 'image_embed'
      });
    }
  }

  // Second pass: find link-embedded URLs  — [label](url)
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  while ((match = linkRegex.exec(text)) !== null) {
    const label = match[1];
    const url = match[2].trim();
    if (attachments.has(url)) continue; // already found as image

    // Check if label hints at file type
    const labelLower = label.toLowerCase();
    let context = 'link';
    if (/\.log|log\b|debug|output|trace|console/i.test(labelLower)) context = 'log_link';

    attachments.set(url, {
      url,
      category: classifyUrl(url, null),
      filename: label && /\.\w+$/.test(label) ? label.replace(/[^a-zA-Z0-9._\-]/g, '_') : extractFilename(url),
      context
    });
  }

  // Third pass: bare URLs matching our patterns (not already captured)
  for (const pattern of [...ATTACHMENT_PATTERNS, ...PASTE_PATTERNS]) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const url = match[0];
      if (!attachments.has(url)) {
        attachments.set(url, {
          url,
          category: classifyUrl(url, null),
          filename: extractFilename(url),
          context: 'bare_url'
        });
      }
    }
  }

  return Array.from(attachments.values());
}

// ── Download a single file ──────────────────────────────────

const MAX_FILE_SIZE = 50 * 1024 * 1024;  // 50MB per file
const MAX_TOTAL_DOWNLOAD = 100 * 1024 * 1024;  // 100MB total per issue

async function downloadFile(url, saveDir, filename, token) {
  const savePath = path.join(saveDir, filename);

  // Skip if already downloaded (idempotent)
  if (fs.existsSync(savePath)) {
    const stats = fs.statSync(savePath);
    return { downloaded: true, localPath: savePath, sizeBytes: stats.size, cached: true };
  }

  const headers = {
    'User-Agent': 'CodeBot/2.0 (Discord coding assistant)',
    'Accept': '*/*'
  };
  // Private repo attachments may need auth
  if (token && /githubusercontent\.com|github\.com/.test(url)) {
    headers['Authorization'] = `token ${token}`;
  }

  const resp = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(60000)
  });

  if (!resp.ok) {
    return { downloaded: false, error: `HTTP ${resp.status} ${resp.statusText}` };
  }

  const chunks = [];
  let totalBytes = 0;
  const reader = resp.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.length;
    if (totalBytes > MAX_FILE_SIZE) {
      reader.cancel();
      return { downloaded: false, error: `File exceeds 50MB limit (${(totalBytes / 1024 / 1024).toFixed(1)}MB)` };
    }
    chunks.push(value);
  }

  const buffer = Buffer.concat(chunks);
  fs.writeFileSync(savePath, buffer);

  return { downloaded: true, localPath: savePath, sizeBytes: buffer.length };
}

// ── Main: process an issue ──────────────────────────────────

async function preprocessIssue(issueData, comments, token) {
  const downloadDir = path.join(config.scratchDir, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  // Collect all text to scan
  const allText = [issueData.body || ''];
  const commentSummaries = [];

  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const body = c.body || '';
    allText.push(body);

    const commentAttachments = extractAttachments(body);
    commentSummaries.push({
      index: i + 1,
      author: c.user?.login || c.author || 'unknown',
      preview: body.substring(0, 120).replace(/\n/g, ' '),
      hasAttachments: commentAttachments.length > 0
    });
  }

  // Extract all attachments from combined text
  const fullText = allText.join('\n---\n');
  const attachments = extractAttachments(fullText);

  // Classify and prepare download list
  const downloadable = [];
  const nonDownloadable = [];
  let totalDownloadEstimate = 0;

  for (const att of attachments) {
    if (att.category === 'image') {
      nonDownloadable.push({ ...att, downloaded: false, reason: 'Image — not downloaded' });
    } else if (att.category === 'archive') {
      nonDownloadable.push({ ...att, downloaded: false, reason: 'Archive — not auto-extracted' });
    } else if (att.category === 'log' || att.category === 'code' || att.category === 'unknown') {
      downloadable.push(att);
    } else {
      nonDownloadable.push({ ...att, downloaded: false });
    }
  }

  // Download text-based files in parallel
  const downloadResults = await Promise.all(
    downloadable.map(async (att) => {
      // Ensure unique filenames
      let filename = att.filename;
      const existing = path.join(downloadDir, filename);
      if (fs.existsSync(existing)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        filename = `${base}_${Date.now()}${ext}`;
      }

      try {
        const result = await downloadFile(att.url, downloadDir, filename, token);
        if (result.downloaded) {
          totalDownloadEstimate += result.sizeBytes;
          if (totalDownloadEstimate > MAX_TOTAL_DOWNLOAD) {
            return {
              ...att,
              downloaded: false,
              error: 'Total download limit (100MB) reached'
            };
          }
        }
        return { ...att, ...result };
      } catch (err) {
        return { ...att, downloaded: false, error: err.message };
      }
    })
  );

  // Build manifest
  const manifest = {
    issue: {
      number: issueData.number,
      title: issueData.title,
      body_preview: (issueData.body || '').substring(0, 500).replace(/\n/g, ' ')
    },
    attachments: [
      ...downloadResults.map(a => ({
        url: a.url,
        category: a.category,
        filename: a.filename,
        downloaded: a.downloaded || false,
        localPath: a.localPath || null,
        sizeBytes: a.sizeBytes || null,
        error: a.error || null
      })),
      ...nonDownloadable.map(a => ({
        url: a.url,
        category: a.category,
        filename: a.filename,
        downloaded: false,
        reason: a.reason || null
      }))
    ],
    commentCount: comments.length,
    commentSummaries
  };

  return manifest;
}

module.exports = { preprocessIssue, extractAttachments, classifyUrl };
