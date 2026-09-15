import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import matter from 'gray-matter';
import { ESG_UPDATE_KINDS, normalizeEsgFrontmatter, type EsgFrontmatter } from './esg-policy.js';

function uniq(values: unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}
function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }
function shortHash(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 12); }
async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}
async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
}
async function appendControl(wikiDir: string, file: string, title: string, entry: string): Promise<void> {
  const path = join(wikiDir, 'control', file);
  const prev = await readText(path) ?? `# ${title}\n`;
  await atomicWrite(path, `${prev.trimEnd()}\n\n## ${new Date().toISOString()}\n\n${entry.trim()}\n`);
}

export async function safeShadowWrite(
  wikiDir: string,
  pagePath: string,
  frontmatter: EsgFrontmatter,
  body: string,
  options: { updateKind?: string; evidenceNote?: string; replaceBody?: boolean } = {},
): Promise<{ status: string; pagePath: string }> {
  const updateKind = options.updateKind ?? 'new';
  if (!ESG_UPDATE_KINDS.has(updateKind)) throw new Error(`Invalid updateKind=${updateKind}`);
  const full = join(wikiDir, pagePath);
  const nextFm = normalizeEsgFrontmatter(frontmatter);
  const priorRaw = await readText(full);

  if (priorRaw === null) {
    await atomicWrite(full, matter.stringify(body.trimEnd(), nextFm));
    return { status: 'created', pagePath };
  }

  const history = join(wikiDir, '.history', dirname(pagePath), basename(pagePath, '.md'), `${stamp()}-${shortHash(priorRaw)}.md`);
  await atomicWrite(history, priorRaw);
  const priorMatter = matter(priorRaw);
  const priorFm = priorMatter.data as EsgFrontmatter;
  const merged = normalizeEsgFrontmatter({
    ...priorFm,
    ...nextFm,
    source_refs: uniq([...(priorFm.source_refs ?? []), ...(nextFm.source_refs ?? [])]),
    requirement_ids: uniq([...(priorFm.requirement_ids ?? []), ...(nextFm.requirement_ids ?? [])]),
    updated: new Date().toISOString(),
  });

  if (options.replaceBody) {
    await atomicWrite(full, matter.stringify(body.trimEnd(), merged));
    return { status: 'replaced-with-history', pagePath };
  }

  if (updateKind === 'conflict') {
    await appendControl(wikiDir, 'contradictions.md', 'Contradictions Ledger',
      `- page: \`${pagePath}\`\n- evidence: ${options.evidenceNote || 'conflicting evidence detected'}\n- source_refs: ${JSON.stringify(nextFm.source_refs ?? [])}`);
    await atomicWrite(full, matter.stringify(priorMatter.content.trim(), merged));
    return { status: 'conflict-recorded', pagePath };
  }
  if (updateKind === 'supersede') {
    merged.review_state = 'superseded';
    merged.superseded_at = new Date().toISOString();
    const nextBody = `${priorMatter.content.trimEnd()}\n\n## Supersession Note\n\n${options.evidenceNote || body}\n`;
    await atomicWrite(full, matter.stringify(nextBody, merged));
    return { status: 'superseded', pagePath };
  }
  const note = options.evidenceNote || body;
  const nextBody = `${priorMatter.content.trimEnd()}\n\n## Evidence Update - ${updateKind} - ${new Date().toISOString()}\n\n${note.trim()}\n`;
  await atomicWrite(full, matter.stringify(nextBody, merged));
  return { status: 'merged', pagePath };
}
