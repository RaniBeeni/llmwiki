import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeEsgFrontmatter } from '../../packages/core/src/esg-policy.js';
import { structureAwareChunks } from '../../packages/core/src/esg-chunk.js';
import { rankEsgCandidates } from '../../packages/core/src/esg-query.js';
import { safeShadowWrite } from '../../packages/core/src/esg-shadow.js';
import { registerEsgSource } from '../../packages/core/src/esg-source-manifest.js';
import { lintEsgPage } from '../../packages/core/src/esg-lint.js';

const tempRoots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'llmwiki-esg-'));
  tempRoots.push(root);
  return root;
}
afterEach(async () => {
  while (tempRoots.length) await rm(tempRoots.pop()!, { recursive: true, force: true });
});

describe('ESG P0 Shadow controls', () => {
  it('forces Shadow state and rejects official-sounding review states', () => {
    expect(normalizeEsgFrontmatter({ type: 'concept', title: 'X' })).toMatchObject({
      status: 'shadow', review_state: 'ai-compiled',
    });
    expect(() => normalizeEsgFrontmatter({ type: 'concept', review_state: 'final' })).toThrow();
    expect(() => normalizeEsgFrontmatter({ type: 'concept', review_state: 'approved' })).toThrow();
  });

  it('chunks long sources without tail truncation and preserves page locators', () => {
    const text = `[PAGE:6]\n# Governance\n${'A'.repeat(13_050)}\n[PAGE:7]\nSecond page tail`;
    const chunks = structureAwareChunks(text, 12_000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.some((c) => c.locator.page === 6)).toBe(true);
    expect(chunks.some((c) => c.locator.page === 7)).toBe(true);
    expect(chunks.map((c) => c.text).join('')).toContain('Second page tail');
  });

  it('prioritizes exact IDs over body-only matches', () => {
    const result = rankEsgCandidates('GOV-1.2', [
      { path: 'exact.md', title: 'Management role', body: 'x', id: 'GOV-1.2' },
      { path: 'body.md', title: 'Other', body: 'Mentions GOV-1.2 in body' },
    ]);
    expect(result[0].path).toBe('exact.md');
    expect(result[0].score).toBeGreaterThanOrEqual(1000);
  });

  it('detects source no-op/version changes by hash', async () => {
    const root = await tempRoot();
    const raw = join(root, 'raw', 'public');
    await mkdir(raw, { recursive: true });
    const source = join(raw, 'source.txt');
    await writeFile(source, 'v1');
    expect((await registerEsgSource(root, { source_id: 'S1', title: 'S', source_path: source, access_classification: 'PUBLIC' })).status).toBe('new');
    expect((await registerEsgSource(root, { source_id: 'S1', title: 'S', source_path: source, access_classification: 'PUBLIC' })).status).toBe('no-op');
    await writeFile(source, 'v2');
    expect((await registerEsgSource(root, { source_id: 'S1', title: 'S', source_path: source, access_classification: 'PUBLIC' })).status).toBe('version-changed');
  });

  it('replaces current Shadow body while preserving prior history and provenance', async () => {
    const root = await tempRoot();
    const wikiDir = join(root, 'wiki');
    await safeShadowWrite(wikiDir, 'concepts/test.md', {
      type: 'concept', title: 'Test', authority_scope: 'synthesis', source_refs: ['S1'],
    }, 'body one');
    await safeShadowWrite(wikiDir, 'concepts/test.md', {
      type: 'concept', title: 'Test', authority_scope: 'synthesis', source_refs: ['S2'],
    }, 'body two', { updateKind: 'extend', replaceBody: true });
    const current = await readFile(join(wikiDir, 'concepts', 'test.md'), 'utf8');
    expect(current).toContain('body two');
    expect(current).not.toContain('body one');
    expect(current).toContain('S1');
    expect(current).toContain('S2');
    const history = await readdir(join(wikiDir, '.history', 'concepts', 'test'));
    expect(history).toHaveLength(1);
  });

  it('adds ESG semantic lint findings for missing locators', () => {
    const findings = lintEsgPage({
      frontmatter: {
        type: 'concept', title: 'X', status: 'shadow', review_state: 'ai-compiled',
        authority_scope: 'synthesis', source_refs: ['S1'],
      },
      body: 'General synthesis without an evidence location.',
    });
    expect(findings.some((f) => f.category === 'missing-locator')).toBe(true);
  });
});
