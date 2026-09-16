import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { READ_TOOLS, handleReadToolCall } from './read-tools.js';
import type { ToolArgs } from './read-tools.js';
import { WRITE_TOOLS, handleWriteToolCall } from './write-tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

const READ_TOOL_NAMES = new Set(READ_TOOLS.map((t) => t.name));
const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

export interface McpServerOptions {
  /** ESG Shadow mode disables every MCP write tool while preserving the generic engine defaults. */
  readOnly?: boolean;
}

/**
 * Create a fully-configured MCP server for LLM Wiki.
 * Generic/default mode preserves upstream read + write tools.
 * ESG Shadow mode (`readOnly: true`) exposes read tools only.
 */
export function createMcpServer(wikiRoot: string, options: McpServerOptions = {}): Server {
  const readOnly = options.readOnly === true;
  const server = new Server(
    { name: 'llmwiki', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: readOnly ? [...READ_TOOLS] : [...READ_TOOLS, ...WRITE_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let text: string;
      if (READ_TOOL_NAMES.has(name)) {
        text = await handleReadToolCall(name, (args ?? {}) as ToolArgs, wikiRoot);
      } else if (WRITE_TOOL_NAMES.has(name)) {
        if (readOnly) {
          throw new Error(`ESG Shadow Pilot MCP is read-only; disabled write tool: ${name}`);
        }
        text = await handleWriteToolCall(name, (args ?? {}) as ToolArgs, wikiRoot);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: 'text' as const, text }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  registerResources(server, wikiRoot);
  registerPrompts(server, wikiRoot);
  return server;
}
