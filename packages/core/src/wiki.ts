import matter from 'gray-matter';
import { readFile, writeFile, readdir, stat, mkdir, unlink } from 'node:fs/promises';
import { join, dirname, extname, relative, resolve } from 'node:path';
import { isNotFoundError } from './errors.js';
import { slugify } from './utils.js';
import { addEntry, escapeMarkdownLinkText, readIndex, removeEntry, writeIndex } from './index-ops.js';
import type { IndexEntry } from './index-ops.js';
import { getBacklinks } from './backlinks.js';
import type { BacklinkResult } from './backlinks.js';
import { safeShadowWrite } from './esg-shadow.js';

export interface WikiPageFrontmatter {
  type?: string;
  title?: string;
  tags?: string[];
  sources?: string[];
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface WikiPage {
  frontmatter: WikiPageFrontmatter;
  body: string;
}

export async function readPage(filePath: string): Promise<WikiPage> {
  const raw = await readFile(filePath, 'utf-8');
  const { data, content } = matter(raw);
  return {
    frontmatter: data as WikiPageFrontmatter,
    body: content.trim(),
  };
}

export async function writePage(filePath: string, page: WikiPage): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const output = matter.stringify(page.body, page.frontmatter);
  await writeFile(filePath, output, 'utf-8');
}

export async function listPages(wikiDir: string): Promise<string[]> {
  try {
    const entries = await readdir(wikiDir, { recursive: true });
    return entries
      .filter((entry) => typeof entry === 'string' && extname(entry) === '.md')
      .map((entry) => join(wikiDir, entry as string));
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

/**
 * Check whether a directory exists.
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

export interface PageLinkDetail {
  /** The display text of the markdown link */
  text: string;
  /** The link target (href) */
  target: string;
}

/**
 * Extract all internal markdown links (relative `.md` paths) from content,
 * returning both the display text and target for each link.
 */
export function getPageLinksDetailed(content: string): PageLinkDetail[] {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const links: PageLinkDetail[] = [];
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(content)) !== null) {
    const text = match[1];
    const target = match[2];
    if (target.endsWith('.md') && !target.startsWith('http://') && !target.startsWith('https://')) {
      links.push({ text, target });
    }
  }
  return links;
}

export function getPageLinks(content: string): string[] {
  return getPageLinksDetailed(content).map((link) => link.target);
}

export interface CreatePageResult {
  path: string;
  indexEntry: IndexEntry;
}

/**
 * Create an entity page at wiki/entities/{slug}.md with proper frontmatter
 * and register it in the wiki index.
 */
export async function createEntityPage(
  wikiDir: string,
  name: string,
  content: string,
  tags: string[] = [],
): Promise<CreatePageResult> {
  const slug = slugify(name);
  const relPath = `entities/${slug}.md`;
  const now = new Date().toISOString();

  await safeShadowWrite(wikiDir, relPath, {
    type: 'entity',
    title: name,
    tags,
    created: now,
    authority_scope: 'synthesis',
    source_refs: [],
  }, content, { updateKind: 'extend' });

  const indexEntry: IndexEntry = {
    path: relPath,
    title: name,
    summary: '',
    category: 'Entities',
    tags,
  };

  const indexPath = join(wikiDir, 'index.md');
  await removeEntry(indexPath, relPath);
  await addEntry(indexPath, indexEntry);

  return { path: relPath, indexEntry };
}

/**
 * Create a concept page at wiki/concepts/{slug}.md with proper frontmatter
 * and register it in the wiki index.
 */
export async function createConceptPage(
  wikiDir: string,
  name: string,
  content: string,
  tags: string[] = [],
): Promise<CreatePageResult> {
  const slug = slugify(name);
  const relPath = `concepts/${slug}.md`;
  const now = new Date().toISOString();

  await safeShadowWrite(wikiDir, relPath, {
    type: 'concept',
    title: name,
    tags,
    created: now,
    authority_scope: 'synthesis',
    source_refs: [],
  }, content, { updateKind: 'extend' });

  const indexEntry: IndexEntry = {
    path: relPath,
    title: name,
    summary: '',
    category: 'Concepts',
    tags,
  };

  const indexPath = join(wikiDir, 'index.md');
  await removeEntry(indexPath, relPath);
  await addEntry(indexPath, indexEntry);

  return { path: relPath, indexEntry };
}

/**
 * Append "See also" crosslinks to a wiki page.
 */
export async function addCrosslinks(
  wikiDir: string,
  fromPage: string,
  toPages: string[],
): Promise<void> {
  if (toPages.length === 0) return;

  const fromFull = join(wikiDir, fromPage);
  try {
    await stat(fromFull);
  } catch (err) {
    if (isNotFoundError(err)) throw new Error(`Source page not found: ${fromPage}`);
    throw err;
  }

  const missing: string[] = [];
  for (const tp of toPages) {
    try {
      await stat(join(wikiDir, tp));
    } catch (err) {
      if (isNotFoundError(err)) missing.push(tp);
      else throw err;
    }
  }
  if (missing.length > 0) throw new Error(`Target pages not found: ${missing.join(', ')}`);

  const page = await readPage(fromFull);
  const linkLines: string[] = [];
  for (const tp of toPages) {
    const toFull = join(wikiDir, tp);
    let title: string;
    try {
      const targetPage = await readPage(toFull);
      title = (targetPage.frontmatter.title as string) || tp.replace(/\.md$/, '').split('/').pop()!;
    } catch {
      title = tp.replace(/\.md$/, '').split('/').pop()!;
    }
    const relLink = relative(dirname(fromFull), toFull).replace(/\\/g, '/');
    linkLines.push(`- [${escapeMarkdownLinkText(title)}](${relLink})`);
  }

  const seeAlsoHeader = '## See also';
  const seeAlsoIndex = page.body.indexOf(seeAlsoHeader);

  let newBody: string;
  if (seeAlsoIndex !== -1) {
    const afterHeader = seeAlsoIndex + seeAlsoHeader.length;
    const nextHeadingMatch = page.body.slice(afterHeader).search(/\n## /);
    const sectionEnd = nextHeadingMatch !== -1 ? afterHeader + nextHeadingMatch : page.body.length;
    const existingSection = page.body.slice(afterHeader, sectionEnd);
    const existingLinks = new Set(
      existingSection.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- [')),
    );
    const newLinks = linkLines.filter((l) => !existingLinks.has(l));
    if (newLinks.length === 0) return;
    const before = page.body.slice(0, sectionEnd).trimEnd();
    const after = page.body.slice(sectionEnd);
    newBody = before + '\n' + newLinks.join('\n') + after;
  } else {
    newBody = page.body.trimEnd() + '\n\n' + seeAlsoHeader + '\n\n' + linkLines.join('\n');
  }

  await writePage(fromFull, { frontmatter: page.frontmatter, body: newBody });
}

export interface DeleteResult {
  deletedPath: string;
  deleted: boolean;
  backlinkWarnings: BacklinkResult[];
}

export async function deletePage(
  wikiDir: string,
  pagePath: string,
): Promise<DeleteResult> {
  const resolvedBase = resolve(wikiDir).replace(/\\/g, '/');
  const resolvedFull = resolve(wikiDir, pagePath).replace(/\\/g, '/');
  if (!resolvedFull.startsWith(resolvedBase + '/') && resolvedFull !== resolvedBase) {
    throw new Error('Path traversal detected — pagePath must stay within wikiDir');
  }

  const fullPath = join(wikiDir, pagePath);
  try {
    await stat(fullPath);
  } catch (err) {
    if (isNotFoundError(err)) throw new Error(`Page not found: ${pagePath}`);
    throw err;
  }

  const backlinkWarnings = await getBacklinks(wikiDir, pagePath);
  const indexPath = join(wikiDir, 'index.md');
  await removeEntry(indexPath, pagePath);
  await unlink(fullPath);

  return { deletedPath: pagePath, deleted: true, backlinkWarnings };
}

export interface RenameResult {
  renamed: boolean;
  oldPath: string;
  newPath: string;
  rewrittenLinks: number;
  affectedPages: string[];
}

export async function renamePage(
  wikiDir: string,
  oldPath: string,
  newPath: string,
): Promise<RenameResult> {
  const resolvedBase = resolve(wikiDir).replace(/\\/g, '/');
  const resolvedOld = resolve(wikiDir, oldPath).replace(/\\/g, '/');
  if (!resolvedOld.startsWith(resolvedBase + '/') && resolvedOld !== resolvedBase) {
    throw new Error('Path traversal detected — oldPath must stay within wikiDir');
  }
  const resolvedNew = resolve(wikiDir, newPath).replace(/\\/g, '/');
  if (!resolvedNew.startsWith(resolvedBase + '/') && resolvedNew !== resolvedBase) {
    throw new Error('Path traversal detected — newPath must stay within wikiDir');
  }

  const oldFull = join(wikiDir, oldPath);
  try {
    await stat(oldFull);
  } catch (err) {
    if (isNotFoundError(err)) throw new Error(`Page not found: ${oldPath}`);
    throw err;
  }

  const newFull = join(wikiDir, newPath);
  try {
    await stat(newFull);
    throw new Error(`Target path already exists: ${newPath}`);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
  }

  const page = await readPage(oldFull);
  const oldStem = oldPath.replace(/\.md$/, '').split('/').pop()!;
  const newStem = newPath.replace(/\.md$/, '').split('/').pop()!;
  if (page.frontmatter.title) {
    const normalizedTitle = page.frontmatter.title.toLowerCase().replace(/[\s_-]+/g, '-');
    const normalizedOldStem = oldStem.toLowerCase().replace(/[\s_-]+/g, '-');
    if (normalizedTitle === normalizedOldStem) {
      page.frontmatter.title = newStem.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  await writePage(newFull, page);
  const allPages = await listPages(wikiDir);
  const normOld = oldPath.replace(/\\/g, '/');
  const affectedPages: string[] = [];
  let rewrittenLinks = 0;

  for (const absPagePath of allPages) {
    if (resolve(absPagePath).replace(/\\/g, '/') === resolvedOld) continue;
    if (resolve(absPagePath).replace(/\\/g, '/') === resolve(newFull).replace(/\\/g, '/')) continue;

    const sourcePage = await readPage(absPagePath);
    const links = getPageLinksDetailed(sourcePage.body);
    let modified = false;
    let updatedBody = sourcePage.body;

    for (const { text, target } of links) {
      const sourceDir = dirname(absPagePath);
      const resolvedAbsolute = join(sourceDir, target);
      const resolvedRelative = relative(wikiDir, resolvedAbsolute).replace(/\\/g, '/');
      if (resolvedRelative === normOld) {
        const newRelLink = relative(dirname(absPagePath), newFull).replace(/\\/g, '/');
        const oldLink = `[${text}](${target})`;
        const newLink = `[${text}](${newRelLink})`;
        updatedBody = updatedBody.replace(oldLink, newLink);
        modified = true;
        rewrittenLinks++;
      }
    }

    if (modified) {
      await writePage(absPagePath, { frontmatter: sourcePage.frontmatter, body: updatedBody });
      const relSourcePath = relative(wikiDir, absPagePath).replace(/\\/g, '/');
      affectedPages.push(relSourcePath);
    }
  }

  const indexPath = join(wikiDir, 'index.md');
  const entries = await readIndex(indexPath);
  const entryIdx = entries.findIndex((e) => e.path === oldPath);
  if (entryIdx >= 0) {
    entries[entryIdx].path = newPath;
    if (page.frontmatter.title) entries[entryIdx].title = page.frontmatter.title;
    await writeIndex(indexPath, entries);
  }

  await unlink(oldFull);
  return { renamed: true, oldPath, newPath, rewrittenLinks, affectedPages };
}
