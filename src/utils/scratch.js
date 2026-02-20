import { mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

/**
 * Manages the scratch space directory for repo clones and file operations.
 */

/**
 * Ensure the scratch directory exists.
 */
export function ensureScratchDir() {
  if (!existsSync(config.scratchDir)) {
    mkdirSync(config.scratchDir, { recursive: true });
  }
}

/**
 * Get a path within the scratch space. Validates that the resolved path
 * is within the scratch directory to prevent path traversal.
 */
export function scratchPath(...segments) {
  const resolved = join(config.scratchDir, ...segments);
  const normalizedScratch = config.scratchDir.replace(/\\/g, '/');
  const normalizedResolved = resolved.replace(/\\/g, '/');

  if (!normalizedResolved.startsWith(normalizedScratch)) {
    throw new Error(`Path traversal detected: ${resolved} is outside scratch space`);
  }
  return resolved;
}

/**
 * Clean up the entire scratch space.
 */
export function cleanScratch() {
  if (existsSync(config.scratchDir)) {
    rmSync(config.scratchDir, { recursive: true, force: true });
  }
  ensureScratchDir();
}

/**
 * Clean a specific subdirectory within scratch space.
 */
export function cleanScratchSubdir(name) {
  const dir = scratchPath(name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * List contents of scratch space (top-level).
 */
export function listScratch(subdir = '') {
  const dir = subdir ? scratchPath(subdir) : config.scratchDir;
  if (!existsSync(dir)) return [];

  return readdirSync(dir).map(name => {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    return {
      name,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
    };
  });
}

/**
 * Get disk usage of scratch space in bytes.
 */
export function scratchUsage() {
  if (!existsSync(config.scratchDir)) return 0;

  function dirSize(dir) {
    let total = 0;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        total += dirSize(full);
      } else {
        total += stat.size;
      }
    }
    return total;
  }

  return dirSize(config.scratchDir);
}

/**
 * Format bytes to human readable.
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
