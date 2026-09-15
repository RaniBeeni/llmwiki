import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertEsgAccessClass } from './esg-policy.js';

export interface EsgSourceRegistration {
  source_id: string;
  title: string;
  source_path: string;
  access_classification: string;
  authority?: string;
  official_uri?: string;
  version?: string;
  effective_date?: string;
}

interface Manifest { schema_version: number; updated_at?: string; sources: Record<string, any>; }
async function sha256(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex'); }
async function load(path: string): Promise<Manifest> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Manifest; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { schema_version: 1, sources: {} }; throw err; }
}
async function atomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.tmp-${Date.now()}`;
  await writeFile(tmp, content, 'utf8'); await rename(tmp, path);
}

export async function registerEsgSource(wikiRoot: string, meta: EsgSourceRegistration): Promise<{ status: string; hash: string }> {
  assertEsgAccessClass(meta.access_classification);
  const manifestPath = join(wikiRoot, 'raw', 'manifest.json');
  const hash = await sha256(meta.source_path);
  const manifest = await load(manifestPath);
  const prev = manifest.sources[meta.source_id];
  if (prev?.current_hash === hash) return { status: 'no-op', hash };
  const now = new Date().toISOString();
  const version = { hash, version: meta.version ?? null, effective_date: meta.effective_date ?? null, ingested_at: now, source_path: meta.source_path };
  manifest.sources[meta.source_id] = {
    source_id: meta.source_id, title: meta.title, authority: meta.authority ?? null, official_uri: meta.official_uri ?? null,
    access_classification: meta.access_classification, current_hash: hash, current_version: meta.version ?? null,
    status: 'active', versions: [...(prev?.versions ?? []), version],
  };
  manifest.updated_at = now;
  await atomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { status: prev ? 'version-changed' : 'new', hash };
}

export async function deactivateEsgSource(wikiRoot: string, sourceId: string, reason = 'deactivated'): Promise<void> {
  const path = join(wikiRoot, 'raw', 'manifest.json');
  const manifest = await load(path); const source = manifest.sources[sourceId];
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  source.status = 'inactive'; source.deactivated_at = new Date().toISOString(); source.deactivation_reason = reason;
  manifest.updated_at = new Date().toISOString(); await atomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
