import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { appendEntry } from './log.js';
import { API_VERSION, WIKI_DIR_NAME } from './constants.js';
import { isNotFoundError } from './errors.js';
import { ESG_AGENTS_CONTENT, ESG_DIRS, ESG_INDEX_CONTENT } from './esg-policy.js';

/**
 * Result of running the init command.
 */
export interface InitResult {
  command: string;
  api_version: string;
  status: 'created' | 'already_initialized';
  created_dirs: string[];
  created_files: string[];
  warning?: string;
}

/** Directories created by init, relative to root. */
const DIRS = ESG_DIRS;

/** The starter wiki/index.md with empty category sections. */
const INDEX_CONTENT = ESG_INDEX_CONTENT;

/** AGENTS.md starter schema template. */
const AGENTS_CONTENT = ESG_AGENTS_CONTENT;

/**
 * Initialize a wiki knowledge base at the given path.
 * Creates the `.wiki` directory containing the wiki structure.
 * The `targetPath` is the project/workspace folder; the wiki root
 * will be `targetPath/.wiki/`.
 *
 * Returns a structured result describing what was created.
 */
export async function initWiki(targetPath: string): Promise<InitResult> {
  const root = resolve(targetPath, WIKI_DIR_NAME);
  const wikiDir = join(root, 'wiki');

  // Detect if already initialized
  try {
    const wikiStat = await stat(wikiDir);
    if (wikiStat.isDirectory()) {
      return {
        command: 'init',
        api_version: API_VERSION,
        status: 'already_initialized',
        created_dirs: [],
        created_files: [],
        warning: 'Wiki is already initialized (wiki/ directory exists)',
      };
    }
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // Directory does not exist — proceed with init
  }

  // Create directory structure
  for (const dir of DIRS) {
    await mkdir(join(root, dir), { recursive: true });
  }

  // Create wiki/index.md with category sections
  const indexPath = join(root, 'wiki', 'index.md');
  await writeFile(indexPath, INDEX_CONTENT, 'utf-8');

  // Create wiki/log.md with initialization entry
  const logPath = join(root, 'wiki', 'log.md');
  await appendEntry(logPath, {
    verb: 'initialized',
    subject: 'wiki',
    details: 'Wiki knowledge base initialized.',
  });

  // Create AGENTS.md with starter schema
  const agentsPath = join(root, 'AGENTS.md');
  await writeFile(agentsPath, AGENTS_CONTENT, 'utf-8');

  const createdFiles = ['wiki/index.md', 'wiki/log.md', 'AGENTS.md'];

  return {
    command: 'init',
    api_version: API_VERSION,
    status: 'created',
    created_dirs: [...DIRS],
    created_files: createdFiles,
  };
}
