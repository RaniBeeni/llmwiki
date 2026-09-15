import * as vscode from 'vscode';
import { join, resolve, basename } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
import {
  readIndex,
  directoryExists,
  initWiki,
  lintWiki,
  queryWiki,
  getWikiStatus,
  isNotFoundError,
  type IndexEntry,
} from '@llmwiki/core';
import { llmIngest } from './llmIngest';
import { selectModelInteractively } from './modelSelection';
import type { WikiPagesTreeDataProvider } from './wikiPagesTree';
import type { RawSourcesTreeDataProvider } from './rawSourcesTree';

async function ensureInRaw(
  filePath: string,
  rawDir: string,
  workspaceFolder: string,
): Promise<string> {
  const resolved = resolve(filePath).replace(/\\/g, '/');
  const root = resolve(rawDir).replace(/\\/g, '/');
  if (resolved.startsWith(root + '/') || resolved === root) return filePath;
  await mkdir(rawDir, { recursive: true });
  const dest = join(rawDir, basename(filePath));
  await copyFile(filePath, dest);
  return dest;
}

const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'build', '.wiki']);
function isUri(value: unknown): value is vscode.Uri {
  return value !== null && typeof value === 'object' && 'fsPath' in value &&
    typeof (value as { fsPath: unknown }).fsPath === 'string' && 'scheme' in value;
}
async function walkFolder(folder: vscode.Uri): Promise<vscode.Uri[]> {
  const files: vscode.Uri[] = []; const stack: vscode.Uri[] = [folder];
  while (stack.length > 0) {
    const current = stack.pop()!; let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(current); } catch { continue; }
    for (const [name, type] of entries) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const child = vscode.Uri.joinPath(current, name);
      if (type === vscode.FileType.Directory) stack.push(child);
      else if (type === vscode.FileType.File) files.push(child);
    }
  }
  return files;
}
async function expandSelectionToFiles(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
  const files: vscode.Uri[] = [];
  for (const uri of uris) {
    let stat: vscode.FileStat; try { stat = await vscode.workspace.fs.stat(uri); } catch { continue; }
    if (stat.type === vscode.FileType.Directory) files.push(...(await walkFolder(uri)));
    else if (stat.type === vscode.FileType.File) files.push(uri);
  }
  const seen = new Set<string>();
  return files.filter((u) => { const key = resolve(u.fsPath); if (seen.has(key)) return false; seen.add(key); return true; });
}

interface TreeProviders { entities: WikiPagesTreeDataProvider; concepts: WikiPagesTreeDataProvider; rawSources: RawSourcesTreeDataProvider; }

export function registerCommands(
  context: vscode.ExtensionContext,
  projectFolder: string,
  workspaceFolder: string,
  providers: TreeProviders,
  outputChannel: vscode.OutputChannel,
): void {
  const reg = (id: string, handler: (...args: unknown[]) => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try { await handler(...args); }
      catch (err: unknown) { const msg = err instanceof Error ? err.message : String(err); outputChannel.appendLine(`[${id}] Error: ${msg}`); vscode.window.showErrorMessage(`LLM Wiki: ${msg}`); }
    }));
  };
  const wikiDir = join(workspaceFolder, 'wiki'); const indexPath = join(wikiDir, 'index.md'); const rawDir = join(workspaceFolder, 'raw');

  reg('llmwiki.init', async () => {
    if (await directoryExists(wikiDir)) { vscode.window.showWarningMessage('Wiki is already initialized (wiki/ directory exists).'); return; }
    const result = await initWiki(projectFolder);
    vscode.window.showInformationMessage(`Wiki initialized in .wiki/: ${result.created_dirs.length} directories, ${result.created_files.length} files created.`);
    providers.entities.refresh(); providers.concepts.refresh();
  });

  reg('llmwiki.ingest', async (...args: unknown[]) => {
    if (!(await directoryExists(wikiDir))) {
      const choice = await vscode.window.showWarningMessage('Wiki not initialized.', 'Initialize Now');
      if (choice === 'Initialize Now') await vscode.commands.executeCommand('llmwiki.init');
      return;
    }
    let initialSelection: vscode.Uri[] = []; const [first, second] = args;
    if (Array.isArray(second) && second.every(isUri)) initialSelection = second;
    else if (Array.isArray(first) && first.every(isUri)) initialSelection = first;
    else if (isUri(first)) initialSelection = [first];
    if (initialSelection.length === 0) {
      const mode = await vscode.window.showQuickPick([
        { label: '$(file) Files', description: 'Pick one or more files to ingest', value: 'files' as const },
        { label: '$(file-directory) Folder', description: 'Pick a folder (walked recursively)', value: 'folder' as const },
      ], { title: 'Ingest sources', placeHolder: 'What do you want to ingest?' });
      if (!mode) return;
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: mode.value === 'files', canSelectFolders: mode.value === 'folder', canSelectMany: true,
        defaultUri: vscode.Uri.file(rawDir), openLabel: 'Ingest', title: mode.value === 'files' ? 'Select source files to ingest' : 'Select folder(s) to ingest',
      });
      if (!picked || picked.length === 0) return; initialSelection = picked;
    }
    const files = await expandSelectionToFiles(initialSelection);
    if (files.length === 0) { vscode.window.showInformationMessage('No files found in the selection.'); return; }
    const accessClass = await vscode.window.showQuickPick([
      { label: 'PUBLIC', description: 'Public external standard / benchmark source', value: 'public' as const },
      { label: 'APPROVED-PROJECT', description: 'Approved project knowledge only', value: 'approved-project' as const },
    ], { title: 'ESG source access classification', placeHolder: 'P0 rejects all other source classes' });
    if (!accessClass) return;
    const classifiedRawDir = join(rawDir, accessClass.value);
    if (files.length > 20) {
      const confirm = await vscode.window.showWarningMessage(`You are about to ingest ${files.length} files. Continue?`, { modal: true }, 'Ingest All');
      if (confirm !== 'Ingest All') return;
    }
    let totalCreated=0,totalUpdated=0,succeeded=0,failed=0;
    await vscode.window.withProgress({ location:vscode.ProgressLocation.Notification, title:`Ingesting ${files.length} file${files.length===1?'':'s'}…`, cancellable:true }, async (progress,cancelToken) => {
      const total=files.length;
      for(let i=0;i<total;i++){
        if(cancelToken.isCancellationRequested)break;
        const uri=files[i]; const fileName=uri.fsPath.split(/[\\/]/).pop()??'file'; progress.report({message:`(${i+1}/${total}) ${fileName}`,increment:100/total});
        try{const sourcePath=await ensureInRaw(uri.fsPath,classifiedRawDir,workspaceFolder);const result=await llmIngest(sourcePath,workspaceFolder,false,outputChannel,progress,cancelToken);totalCreated+=result.pagesCreated.length;totalUpdated+=result.pagesUpdated.length;succeeded++;}
        catch(err){outputChannel.appendLine(`[ingest] Failed ${fileName}: ${err instanceof Error?err.message:String(err)}`);failed++;}
      }
    });
    const parts=[`${succeeded} file(s) ingested`];if(totalCreated>0)parts.push(`${totalCreated} pages created`);if(totalUpdated>0)parts.push(`${totalUpdated} pages updated`);if(failed>0)parts.push(`${failed} failed`);
    vscode.window.showInformationMessage(`Ingest complete — ${parts.join(', ')}`);providers.entities.refresh();providers.concepts.refresh();providers.rawSources.refresh();
  });

  context.subscriptions.push(vscode.commands.registerCommand('llmwiki.removeSource', async () => {
    vscode.window.showWarningMessage('ESG Shadow Pilot: Remove Source is disabled. Deactivate/supersede sources instead.');
  }));

  reg('llmwiki.query', async () => {
    if (!(await directoryExists(wikiDir))) { vscode.window.showWarningMessage('Wiki not initialized. Run "LLM Wiki: Initialize Wiki" first.'); return; }
    const queryStr=await vscode.window.showInputBox({prompt:'Search the wiki',placeHolder:'Enter search terms…'});if(!queryStr)return;
    const output=await queryWiki(queryStr,workspaceFolder,false);if(output.matches===0){vscode.window.showInformationMessage(`No results for "${queryStr}".`);return;}
    const pick=await vscode.window.showQuickPick(output.results.map(r=>({label:r.title,description:`Score: ${r.score}`,detail:r.excerpt,path:r.path})),{placeHolder:`${output.matches} result(s) for "${queryStr}"`,matchOnDetail:true});
    if(pick)await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(join(wikiDir,pick.path)));
  });

  reg('llmwiki.status',async()=>{const status=await getWikiStatus(workspaceFolder);const lines=[`Pages: ${status.wiki_page_count}`,`Sources: ${status.source_count}`,`Coverage: ${status.index_coverage_pct}%`,`Last ingest: ${status.last_ingest_date??'—'}`,`Orphans: ${status.orphan_page_count}`];vscode.window.showInformationMessage(`Wiki Status — ${lines.join(' | ')}`);});

  reg('llmwiki.openPage',async()=>{let entries:IndexEntry[];try{entries=await readIndex(indexPath);}catch(err){if(!isNotFoundError(err))throw err;vscode.window.showWarningMessage('Wiki not initialized. Run "LLM Wiki: Initialize Wiki" first.');return;}if(entries.length===0){vscode.window.showInformationMessage('No pages in the wiki yet.');return;}const pick=await vscode.window.showQuickPick(entries.map(e=>({label:e.title,description:e.category,detail:e.summary,path:e.path})),{placeHolder:'Select a wiki page to open',matchOnDetail:true});if(pick)await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(join(wikiDir,pick.path)));});

  reg('llmwiki.search',async()=>{if(!(await directoryExists(wikiDir))){vscode.window.showWarningMessage('Wiki not initialized.');return;}const queryStr=await vscode.window.showInputBox({prompt:'Search entities and concepts',placeHolder:'Enter search terms…'});if(!queryStr)return;let entries:IndexEntry[]=[];try{entries=await readIndex(indexPath);}catch{return;}const q=queryStr.toLowerCase();const matches=entries.filter(e=>e.category==='Entities'||e.category==='Concepts').filter(e=>e.title.toLowerCase().includes(q)||e.summary.toLowerCase().includes(q)||e.tags.some(t=>t.toLowerCase().includes(q))).map(e=>({label:`$(${e.category==='Entities'?'person':'lightbulb'}) ${e.title}`,description:e.category,detail:e.summary,path:e.path}));if(matches.length===0){vscode.window.showInformationMessage(`No entities or concepts matching "${queryStr}".`);return;}const pick=await vscode.window.showQuickPick(matches,{placeHolder:`${matches.length} result(s) for "${queryStr}"`,matchOnDetail:true});if(pick)await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(join(wikiDir,pick.path)));});

  reg('llmwiki.searchRaw',async()=>{const{listSources}=await import('@llmwiki/core');const sources=await listSources(rawDir);if(sources.length===0){vscode.window.showInformationMessage('No source files in raw/.');return;}const queryStr=await vscode.window.showInputBox({prompt:'Search source files',placeHolder:'Enter filename…'});if(!queryStr)return;const q=queryStr.toLowerCase();const matches=sources.filter(s=>s.name.toLowerCase().includes(q)).map(s=>({label:`$(file) ${s.name}`,description:`${s.size} bytes`,path:s.path}));if(matches.length===0){vscode.window.showInformationMessage(`No sources matching "${queryStr}".`);return;}const pick=await vscode.window.showQuickPick(matches,{placeHolder:`${matches.length} source(s) matching "${queryStr}"`});if(pick)await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(join(rawDir,pick.path)));});

  reg('llmwiki.refresh',async()=>{
    if(!(await directoryExists(wikiDir))){providers.entities.refresh();providers.concepts.refresh();providers.rawSources.refresh();return;}
    const health=await lintWiki(workspaceFolder);providers.entities.refresh();providers.concepts.refresh();providers.rawSources.refresh();
    if(health.errorCount===0&&health.warningCount===0)vscode.window.showInformationMessage('Wiki refreshed — read-only health check passed ✓');
    else vscode.window.showWarningMessage(`Wiki refreshed — read-only health check found ${health.errorCount} error(s), ${health.warningCount} warning(s). Use @wiki /lint for details.`);
  });

  reg('llmwiki.selectModel',async()=>{await selectModelInteractively(outputChannel);});
}
