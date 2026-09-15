import * as vscode from 'vscode';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { WIKI_DIR_NAME } from '@llmwiki/core';

/**
 * Registers the MCP server used by Copilot Chat.
 * ESG Shadow workspaces launch the generic engine with `--read-only`, keeping
 * upstream MCP writes available for non-ESG uses while disabling them here.
 */
export function registerMcpServerProvider(
  context: vscode.ExtensionContext,
  workspaceFolder: string,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable | undefined {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') {
    outputChannel.appendLine(
      '[mcp] vscode.lm.registerMcpServerDefinitionProvider unavailable — skipping auto-registration.',
    );
    return undefined;
  }

  const wikiRoot = join(workspaceFolder, WIKI_DIR_NAME);
  let launcherPath: string | undefined;
  const bundled = context.asAbsolutePath(join('out', 'mcp-server.cjs'));
  if (existsSync(bundled)) {
    launcherPath = bundled;
  } else {
    try {
      launcherPath = require.resolve('@llmwiki/core/mcp-bin');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputChannel.appendLine(`[mcp] Could not locate llmwiki-mcp launcher: ${msg}`);
      return undefined;
    }
  }

  const emitter = new vscode.EventEmitter<void>();
  const provider: vscode.McpServerDefinitionProvider = {
    onDidChangeMcpServerDefinitions: emitter.event,
    provideMcpServerDefinitions: () => {
      const definition = new vscode.McpStdioServerDefinition(
        'LLM Wiki',
        process.execPath,
        [launcherPath, wikiRoot, '--read-only'],
        {},
        context.extension.packageJSON.version as string,
      );
      definition.cwd = vscode.Uri.file(workspaceFolder);
      return [definition];
    },
  };

  outputChannel.appendLine(
    `[mcp] Registered ESG Shadow llmwiki MCP server → ${launcherPath} ${wikiRoot} --read-only`,
  );

  const disposable = vscode.lm.registerMcpServerDefinitionProvider('llmwiki', provider);
  context.subscriptions.push(disposable, emitter);
  return disposable;
}
