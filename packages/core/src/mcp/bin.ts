#!/usr/bin/env node
/**
 * llmwiki-mcp — stdio launcher for the LLM Wiki MCP server.
 *
 * Usage:
 *   llmwiki-mcp [wiki-root] [--read-only]
 *   npx -p @llmwiki/core llmwiki-mcp [wiki-root] [--read-only]
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { WIKI_DIR_NAME } from '../constants.js';
import { createMcpServer } from './server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const readOnly = args.includes('--read-only');
  const rootArg = args.find((arg) => !arg.startsWith('--'));
  const wikiRoot = resolve(rootArg && rootArg.length > 0 ? rootArg : `./${WIKI_DIR_NAME}`);

  try {
    const info = await stat(wikiRoot);
    if (!info.isDirectory()) {
      process.stderr.write(`llmwiki-mcp: ${wikiRoot} exists but is not a directory.\n`);
      process.exit(1);
    }
  } catch {
    process.stderr.write(
      `llmwiki-mcp: wiki root not found at ${wikiRoot}.\n` +
      `Initialize one first or pass the path explicitly:\n` +
      `  llmwiki-mcp <path/to/.wiki> [--read-only]\n`,
    );
    process.exit(1);
  }

  const server = createMcpServer(wikiRoot, { readOnly });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`llmwiki-mcp: fatal error — ${msg}\n`);
  process.exit(1);
});
