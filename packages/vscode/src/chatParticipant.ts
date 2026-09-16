import * as vscode from 'vscode';
import { join } from 'node:path';
import { selectPreferredModel } from './modelSelection';
import {
  queryWiki,
  readIndex,
  readPage,
  directoryExists,
  lintWiki,
  type IndexEntry,
  safeShadowWrite,
} from '@llmwiki/core';

import { WIKI_DIR_NAME } from '@llmwiki/core';

async function getModel(
  requestModel: vscode.LanguageModelChat,
  outputChannel: vscode.OutputChannel,
): Promise<vscode.LanguageModelChat> {
  const preferred = await selectPreferredModel(outputChannel);
  if (preferred) return preferred;
  outputChannel.appendLine(`[wiki chat] Using request model: ${requestModel.family}`);
  return requestModel;
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  workspaceFolder: string,
  outputChannel: vscode.OutputChannel,
): void {
  const wikiRoot = join(workspaceFolder, WIKI_DIR_NAME);
  const wikiDir = join(wikiRoot, 'wiki');
  const indexPath = join(wikiDir, 'index.md');

  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ) => {
    if (!(await directoryExists(wikiDir))) {
      stream.markdown('The wiki is not initialized yet. Run **LLM Wiki: Initialize Wiki** from the command palette first.');
      return;
    }
    if (request.command === 'status') return handleStatus(wikiRoot, stream);
    if (request.command === 'lint') return handleLint(request, wikiRoot, wikiDir, stream, token, outputChannel);
    if (request.command === 'fix') {
      stream.markdown('**ESG Shadow Pilot:** destructive `/fix` is disabled. Run `/lint` and review findings manually.');
      return;
    }
    if (request.command === 'save') return handleSave(request, chatContext, wikiRoot, stream, outputChannel);
    return handleQuery(request, chatContext, stream, token, wikiRoot, wikiDir, indexPath, outputChannel);
  };

  const participant = vscode.chat.createChatParticipant('llmwiki.wiki', handler);
  participant.iconPath = new vscode.ThemeIcon('book');
  context.subscriptions.push(participant);
}

function selectRelevantExcerpt(body: string, query: string, maxChars = 6000): string {
  if (body.length <= maxChars) return body;
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const lower = body.toLowerCase();
  const positions = terms.map((t) => lower.indexOf(t)).filter((p) => p >= 0);
  const center = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, center - Math.floor(maxChars / 3));
  const end = Math.min(body.length, start + maxChars);
  return `${start > 0 ? '…\n' : ''}${body.slice(start, end)}${end < body.length ? '\n…' : ''}`;
}

async function handleQuery(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  wikiRoot: string,
  wikiDir: string,
  indexPath: string,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const question = request.prompt.trim();
  if (!question) { stream.markdown('Ask me anything about your wiki knowledge base.'); return; }
  stream.progress('Searching wiki…');
  let entries: IndexEntry[] = [];
  try { entries = await readIndex(indexPath); } catch {}
  const searchResult = await queryWiki(question, wikiRoot, false);
  const topResults = searchResult.results.slice(0, 12);
  stream.progress('Reading relevant pages…');
  const pageContents: Array<{ title: string; path: string; content: string }> = [];
  for (const result of topResults) {
    try {
      const page = await readPage(join(wikiDir, result.path));
      pageContents.push({
        title: result.title,
        path: result.path,
        content: `Frontmatter: ${JSON.stringify(page.frontmatter)}\n\n${selectRelevantExcerpt(page.body, question, 6000)}`,
      });
    } catch {}
  }
  const wikiIndex = entries.map((e) => `- [${e.title}](${e.path}) (${e.category}): ${e.summary}`).join('\n');
  const relevantPages = pageContents.length > 0
    ? pageContents.map((p) => `### ${p.title} (${p.path})\n${p.content}`).join('\n\n---\n\n')
    : 'No pages matched the query.';
  const previousMessages = chatContext.history.filter((h): h is vscode.ChatResponseTurn => h instanceof vscode.ChatResponseTurn);
  const messages: vscode.LanguageModelChatMessage[] = [];
  messages.push(vscode.LanguageModelChatMessage.User(
`You are a knowledgeable assistant that answers questions using a personal wiki knowledge base. You have access to the wiki's index and relevant page content below.

Rules:
- Treat the wiki as a SHADOW knowledge layer, not the official source of truth.
- Answer based on the wiki content and cite specific pages; when source_refs, requirement_ids, or source locators are present, surface them.
- If the user asks for current/authoritative project truth, say the Shadow Wiki should be verified against the official source / Requirement Backbone / Notion SSoT.
- If the wiki doesn't contain enough information to answer, say so honestly and suggest what sources could be added.
- Be concise but thorough. Use markdown formatting.
- If the answer reveals connections between pages, mention them.
- Good answers can become wiki pages themselves. If the user's question produces a valuable synthesis, suggest they save it with /save.

## Wiki Index
${wikiIndex || 'No pages in the index yet.'}

## Relevant Pages
${relevantPages}`));
  for (const turn of previousMessages) {
    let fullMessage = '';
    for (const part of turn.response) if (part instanceof vscode.ChatResponseMarkdownPart) fullMessage += part.value.value;
    if (fullMessage) messages.push(vscode.LanguageModelChatMessage.Assistant(fullMessage));
  }
  for (const turn of chatContext.history) if (turn instanceof vscode.ChatRequestTurn) messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
  messages.push(vscode.LanguageModelChatMessage.User(question));
  stream.progress('Thinking…');
  try {
    const model = await getModel(request.model, outputChannel);
    const chatResponse = await model.sendRequest(messages, {}, token);
    for await (const fragment of chatResponse.text) stream.markdown(fragment);
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      outputChannel.appendLine(`[wiki chat] LLM error: ${err.message} (${err.code})`);
      stream.markdown(`Failed to get a response: ${err.message}`);
    } else throw err;
  }
  if (pageContents.length > 0) {
    stream.markdown('\n\n---\n**Sources:**\n');
    for (const page of pageContents) { stream.anchor(vscode.Uri.file(join(wikiDir, page.path)), page.title); stream.markdown(' '); }
  }
}

async function handleStatus(wikiRoot: string, stream: vscode.ChatResponseStream): Promise<void> {
  const { getWikiStatus } = await import('@llmwiki/core');
  const status = await getWikiStatus(wikiRoot);
  stream.markdown(`## Wiki Status\n\n`);
  stream.markdown(`| Metric | Value |\n|--------|-------|\n`);
  stream.markdown(`| Pages | ${status.wiki_page_count} |\n`);
  stream.markdown(`| Sources | ${status.source_count} |\n`);
  stream.markdown(`| Coverage | ${status.index_coverage_pct}% |\n`);
  stream.markdown(`| Last ingest | ${status.last_ingest_date ?? '—'} |\n`);
  stream.markdown(`| Orphans | ${status.orphan_page_count} |\n`);
}

async function handleSave(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  wikiRoot: string,
  stream: vscode.ChatResponseStream,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  const name = request.prompt.trim();
  if (!name) {
    stream.markdown('Usage: `@wiki /save <page name>`\n\nSaves the previous assistant answer as a **Shadow query synthesis**, never as official knowledge.');
    return;
  }
  const previous = [...chatContext.history].reverse().find((h): h is vscode.ChatResponseTurn => h instanceof vscode.ChatResponseTurn);
  if (!previous) { stream.markdown('No previous assistant response is available to save.'); return; }
  let body = '';
  for (const part of previous.response) if (part instanceof vscode.ChatResponseMarkdownPart) body += part.value.value;
  if (!body.trim()) { stream.markdown('The previous assistant response has no Markdown content to save.'); return; }
  const wikiDir = join(wikiRoot, 'wiki');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'saved-query';
  const relPath = `queries/${slug}.md`;
  await safeShadowWrite(wikiDir, relPath, {
    type: 'query', title: name, authority_scope: 'synthesis', source_refs: [], created: new Date().toISOString(),
  }, body.trim(), { updateKind: 'extend', replaceBody: true, evidenceNote: 'Saved from @wiki chat response.' });
  outputChannel.appendLine(`[wiki chat] Saved Shadow synthesis: ${relPath}`);
  stream.markdown(`Saved as Shadow synthesis: \`${relPath}\``);
}

async function handleLint(
  request: vscode.ChatRequest,
  wikiRoot: string,
  wikiDir: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  outputChannel: vscode.OutputChannel,
): Promise<void> {
  stream.progress('Running wiki health checks…');
  const result = await lintWiki(wikiRoot);
  if (result.findings.length === 0) { stream.markdown('**Wiki health check passed** — no issues found.\n'); return; }
  const findingsSummary = result.findings.map((f) => `- **${f.severity}** (${f.category}): ${f.message}${f.file ? ` — \`${f.file}\`` : ''}`).join('\n');
  const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(
`You are a wiki health advisor. Analyze the following lint findings and provide a concise, actionable summary. Do not apply destructive fixes.

## Lint Results
- Errors: ${result.errorCount}
- Warnings: ${result.warningCount}
- Info: ${result.infoCount}

## Findings
${findingsSummary}`)];
  try {
    const model = await getModel(request.model, outputChannel);
    const chatResponse = await model.sendRequest(messages, {}, token);
    for await (const fragment of chatResponse.text) stream.markdown(fragment);
  } catch (err) {
    outputChannel.appendLine(`[wiki chat] Lint advisor error: ${err}`);
    stream.markdown(`## Wiki Lint Results\n\n**${result.errorCount}** errors, **${result.warningCount}** warnings\n\n${findingsSummary}`);
  }
  const filesReferenced = new Set<string>();
  for (const finding of result.findings) if (finding.file && !filesReferenced.has(finding.file)) {
    filesReferenced.add(finding.file); stream.reference(vscode.Uri.file(join(wikiDir, finding.file)));
  }
}

// /fix is deliberately disabled in ESG Shadow Pilot P0.
