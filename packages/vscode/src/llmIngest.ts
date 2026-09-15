import * as vscode from 'vscode';
import { basename, join, relative } from 'node:path';
import { extractText } from './extractText';
import { selectPreferredModel } from './modelSelection';
import { analyzeSourceInChunks } from './esgChunkedAnalysis';
import {
  ingestSource,
  readIndex,
  readPage,
  writePage,
  createEntityPage,
  createConceptPage,
  addCrosslinks,
  appendEntry,
  type IndexEntry,
  classifyEsgSourcePath,
  registerEsgSource,
  safeShadowWrite,
} from '@llmwiki/core';

interface LlmAnalysis {
  summary: string;
  entities: Array<{ name: string; content: string; tags: string[] }>;
  concepts: Array<{ name: string; content: string; tags: string[] }>;
  crosslinks: Array<{ from: string; to: string[] }>;
}

export async function llmIngest(
  sourcePath: string,
  workspaceFolder: string,
  force: boolean,
  outputChannel: vscode.OutputChannel,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
): Promise<{ pagesCreated: string[]; pagesUpdated: string[] }> {
  const wikiDir = join(workspaceFolder, 'wiki');
  const indexPath = join(wikiDir, 'index.md');
  const logPath = join(wikiDir, 'log.md');
  const pagesCreated: string[] = [];
  const pagesUpdated: string[] = [];

  const accessClassification = classifyEsgSourcePath(sourcePath, workspaceFolder);
  const sourceName = basename(sourcePath);
  const sourceRel = relative(workspaceFolder, sourcePath).replace(/\\/g, '/');
  const sourceId = `FILE-${sourceRel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
  const registration = await registerEsgSource(workspaceFolder, {
    source_id: sourceId,
    title: sourceName,
    source_path: sourcePath,
    access_classification: accessClassification,
  });

  progress.report({ message: 'Ingesting source file…' });
  const ingestResult = await ingestSource(sourcePath, workspaceFolder, false, force || registration.status === 'version-changed');
  if (ingestResult.status === 'error') throw new Error(ingestResult.error ?? 'Ingest failed');
  if (ingestResult.status === 'skipped') throw new Error(ingestResult.message ?? 'Source already ingested. Use force to re-ingest.');
  pagesCreated.push(...ingestResult.pages_created);
  pagesUpdated.push(...ingestResult.pages_updated);

  progress.report({ message: 'Extracting text from source…' });
  const sourceContent = await extractText(sourcePath);
  let existingEntries: IndexEntry[] = [];
  try { existingEntries = await readIndex(indexPath); } catch {}
  const wikiContext = existingEntries.length > 0
    ? existingEntries.map(e => `- [${e.title}](${e.path}) (${e.category}): ${e.summary}`).join('\n')
    : 'No existing wiki pages yet.';

  progress.report({ message: 'Analysing with LLM…' });
  const analysis = await analyzeSourceInChunks(
    sourceContent,
    (chunk, locator) => callLlmSingle(chunk, wikiContext, outputChannel, token, locator),
    token,
  );
  if (!analysis) {
    outputChannel.appendLine('[llmIngest] LLM analysis returned nothing — skipping enrichment');
    return { pagesCreated, pagesUpdated };
  }

  const sourceRelPath =
    ingestResult.pages_created.find((p) => p.startsWith('sources/')) ??
    ingestResult.pages_updated.find((p) => p.startsWith('sources/')) ?? '';
  if (analysis.summary && sourceRelPath) {
    progress.report({ message: 'Writing LLM summary…' });
    const summaryPath = join(wikiDir, sourceRelPath);
    try {
      const page = await readPage(summaryPath);
      await safeShadowWrite(wikiDir, sourceRelPath, page.frontmatter, analysis.summary, {
        updateKind: 'extend', replaceBody: true,
        evidenceNote: 'LLM source summary refreshed from the current registered source version.',
      });
      pagesUpdated.push(sourceRelPath);
      outputChannel.appendLine(`[llmIngest] Rewrote summary with history: ${sourceRelPath}`);
    } catch (err) { outputChannel.appendLine(`[llmIngest] Failed to rewrite summary: ${err}`); }
  }

  for (const entity of analysis.entities) {
    progress.report({ message: `Creating entity: ${entity.name}…` });
    try {
      const result = await createEntityPage(wikiDir, entity.name, entity.content, entity.tags);
      const pagePath = join(wikiDir, result.path);
      const page = await readPage(pagePath);
      const priorSources = Array.isArray(page.frontmatter.sources) ? page.frontmatter.sources : [];
      page.frontmatter.sources = [...new Set([...priorSources, sourceRelPath])];
      const priorRefs = Array.isArray(page.frontmatter.source_refs) ? page.frontmatter.source_refs.filter((x): x is string => typeof x === 'string') : [];
      page.frontmatter.source_refs = [...new Set([...priorRefs, sourceRelPath])];
      await writePage(pagePath, page);
      pagesCreated.push(result.path);
    } catch (err) { outputChannel.appendLine(`[llmIngest] Failed to create entity "${entity.name}": ${err}`); }
  }

  for (const concept of analysis.concepts) {
    progress.report({ message: `Creating concept: ${concept.name}…` });
    try {
      const result = await createConceptPage(wikiDir, concept.name, concept.content, concept.tags);
      const pagePath = join(wikiDir, result.path);
      const page = await readPage(pagePath);
      const priorSources = Array.isArray(page.frontmatter.sources) ? page.frontmatter.sources : [];
      page.frontmatter.sources = [...new Set([...priorSources, sourceRelPath])];
      const priorRefs = Array.isArray(page.frontmatter.source_refs) ? page.frontmatter.source_refs.filter((x): x is string => typeof x === 'string') : [];
      page.frontmatter.source_refs = [...new Set([...priorRefs, sourceRelPath])];
      await writePage(pagePath, page);
      pagesCreated.push(result.path);
    } catch (err) { outputChannel.appendLine(`[llmIngest] Failed to create concept "${concept.name}": ${err}`); }
  }

  for (const link of analysis.crosslinks) {
    try { await addCrosslinks(wikiDir, link.from, link.to); pagesUpdated.push(link.from); }
    catch (err) { outputChannel.appendLine(`[llmIngest] Failed to crosslink from "${link.from}": ${err}`); }
  }

  await appendEntry(logPath, {
    verb: 'enriched', subject: ingestResult.pages_created[0] ?? sourcePath,
    details: `LLM created ${analysis.entities.length} entities, ${analysis.concepts.length} concepts, ${analysis.crosslinks.length} crosslinks.`,
  });
  return { pagesCreated, pagesUpdated };
}

async function callLlmSingle(
  sourceContent: string, wikiContext: string, outputChannel: vscode.OutputChannel,
  token: vscode.CancellationToken, locator = 'unknown',
): Promise<LlmAnalysis | null> {
  const model = await selectPreferredModel(outputChannel);
  if (!model) { outputChannel.appendLine('[llmIngest] No Copilot model available — falling back to mechanical ingest'); return null; }
  const systemPrompt = `You are a wiki knowledge-base builder. Analyse this source chunk and return ONLY valid JSON with summary, entities, concepts, and crosslinks. Treat generated knowledge as SHADOW synthesis, never as official approval. Do not invent Requirement IDs or direct-equivalence decisions. Preserve source-locator wording in material claims where possible.`;
  const userMessage = `## Existing Wiki Pages\n${wikiContext}\n\n## Source Locator\n${locator}\n\n## Source Document Chunk\n${sourceContent}`;
  try {
    const response = await model.sendRequest([
      vscode.LanguageModelChatMessage.User(systemPrompt), vscode.LanguageModelChatMessage.User(userMessage),
    ], {}, token);
    let fullResponse = ''; for await (const chunk of response.text) fullResponse += chunk;
    return parseLlmResponse(fullResponse, outputChannel);
  } catch (err) { outputChannel.appendLine(`[llmIngest] LLM error: ${err}`); return null; }
}

function parseLlmResponse(raw: string, outputChannel: vscode.OutputChannel): LlmAnalysis | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    return {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      entities: Array.isArray(parsed.entities) ? parsed.entities.filter((e: any) => typeof e?.name === 'string' && typeof e?.content === 'string').map((e: any) => ({ name:e.name, content:e.content, tags:Array.isArray(e.tags)?e.tags.filter((t:any)=>typeof t==='string'):[] })) : [],
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts.filter((c: any) => typeof c?.name === 'string' && typeof c?.content === 'string').map((c: any) => ({ name:c.name, content:c.content, tags:Array.isArray(c.tags)?c.tags.filter((t:any)=>typeof t==='string'):[] })) : [],
      crosslinks: Array.isArray(parsed.crosslinks) ? parsed.crosslinks.filter((l:any)=>typeof l?.from==='string'&&Array.isArray(l?.to)).map((l:any)=>({from:l.from,to:l.to.filter((t:any)=>typeof t==='string')})) : [],
    };
  } catch (err) { outputChannel.appendLine(`[llmIngest] Failed to parse LLM JSON: ${err}`); return null; }
}
