import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readPage, writePage, directoryExists } from './wiki.js';
import { readIndex, type IndexEntry } from './index-ops.js';
import { appendEntry } from './log.js';
import { countOccurrences } from './search.js';
import { excerpt } from './utils.js';
import { API_VERSION } from './constants.js';
import { isNotFoundError } from './errors.js';
import { safeShadowWrite } from './esg-shadow.js';

export interface QueryResult {
  title: string;
  path: string;
  score: number;
  excerpt: string;
}

export interface QueryOutput {
  command: string;
  api_version: string;
  query: string;
  matches: number;
  results: QueryResult[];
  saved?: string;
}

/**
 * Slugify a query string for use as a filename.
 */
export function slugifyQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

/**
 * Execute a query against the wiki, returning scored results.
 */
export async function queryWiki(
  queryStr: string,
  targetPath: string,
  save = false,
): Promise<QueryOutput> {
  const root = resolve(targetPath);
  const wikiDir = join(root, 'wiki');
  const indexPath = join(wikiDir, 'index.md');

  if (!(await directoryExists(wikiDir))) {
    return {
      command: 'query',
      api_version: API_VERSION,
      query: queryStr,
      matches: 0,
      results: [],
    };
  }

  const entries = await readIndex(indexPath);
  const terms = queryStr.toLowerCase().split(/\s+/).filter(Boolean);

  if (terms.length === 0) {
    return {
      command: 'query',
      api_version: API_VERSION,
      query: queryStr,
      matches: 0,
      results: [],
    };
  }

  // Score index entries by title and summary
  const scored: { entry: IndexEntry; indexScore: number }[] = [];
  for (const entry of entries) {
    let score = 0;
    for (const term of terms) {
      score += countOccurrences(entry.title, term) * 3;
      score += countOccurrences(entry.summary, term) * 2;
    }
    scored.push({ entry, indexScore: score });
  }

  // Read matched pages and add body score
  const results: QueryResult[] = [];
  for (const { entry, indexScore } of scored) {
    let bodyScore = 0;
    let body = '';
    try {
      const pagePath = join(wikiDir, entry.path);
      const page = await readPage(pagePath);
      body = page.body;
      const fm = page.frontmatter as Record<string, unknown>;
      const ids = [
        typeof fm.id === 'string' ? fm.id : '',
        ...(Array.isArray(fm.requirement_ids) ? fm.requirement_ids.filter((x): x is string => typeof x === 'string') : []),
        ...(Array.isArray(fm.source_refs) ? fm.source_refs.filter((x): x is string => typeof x === 'string') : []),
      ].filter(Boolean);
      if (ids.some((id) => id.toLowerCase() === queryStr.toLowerCase())) bodyScore += 1000;
      for (const term of terms) {
        bodyScore += countOccurrences(body, term);
        bodyScore += ids.reduce((sum, id) => sum + countOccurrences(id, term) * 25, 0);
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      // Page file missing — use index score only
    }

    const totalScore = indexScore + bodyScore;
    if (totalScore > 0) {
      results.push({
        title: entry.title,
        path: entry.path,
        score: totalScore,
        excerpt: excerpt(body),
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  const output: QueryOutput = {
    command: 'query',
    api_version: API_VERSION,
    query: queryStr,
    matches: results.length,
    results,
  };

  // Save query result as a wiki page if requested
  if (save && results.length > 0) {
    const slug = slugifyQuery(queryStr);
    const queryRelPath = `queries/${slug}.md`;
    const queryFullPath = join(wikiDir, queryRelPath);
    const today = new Date().toISOString().slice(0, 10);

    await mkdir(join(wikiDir, 'queries'), { recursive: true });

    let body = `# Query: ${queryStr}\n\n`;
    body += `Found ${results.length} result(s).\n\n`;
    for (const r of results) {
      body += `## ${r.title}\n\n`;
      body += `- **Path:** ${r.path}\n`;
      body += `- **Score:** ${r.score}\n`;
      body += `- **Excerpt:** ${r.excerpt}\n\n`;
    }

    await safeShadowWrite(wikiDir, queryRelPath, {
      type: 'query',
      title: `Query: ${queryStr}`,
      created: today,
      query: queryStr,
      authority_scope: 'synthesis',
      source_refs: results.map((r) => r.path),
    }, body.trim(), { updateKind: 'extend', replaceBody: true });

    const logPath = join(wikiDir, 'log.md');
    await appendEntry(logPath, {
      verb: 'queried',
      subject: queryStr,
      details: `Saved query "${queryStr}" → ${queryRelPath} (${results.length} results)`,
    });

    output.saved = queryRelPath;
  }

  return output;
}
