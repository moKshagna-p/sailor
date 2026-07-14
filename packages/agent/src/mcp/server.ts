/**
 * Sailor as an MCP server.
 *
 * This is the *same* tool registry the in-process agent uses — imported, not
 * reimplemented. Point Claude Code, Zed, or Cursor at this and they can tailor a
 * resume with the identical guarantees: compile-before-commit, immutable
 * versions, no fabricated facts.
 *
 *   claude mcp add sailor -- bun run --cwd /path/to/sailor packages/agent/src/mcp/server.ts
 *
 * Two deliberate behavioural differences from the ACP surface, both about who
 * owns the human:
 *
 *   - `requestPermission` auto-approves. The MCP host already runs its own
 *     approval UI; prompting again inside the tool would double-prompt, and a
 *     user who clicks through two dialogs reads neither.
 *   - `askUser` refuses. We have no channel to the human here, and inventing an
 *     answer is precisely the failure mode the whole system exists to prevent —
 *     so the tool tells the model to ask in chat instead.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { GapAnalysis } from '@sailor/core';
import {
  commitVersion,
  ensureUser,
  getCurrentVersion,
  getJobTarget,
  listResumes,
} from '@sailor/db';
import type { z } from 'zod';
import type { ToolContext } from '../tools/context.ts';
import { buildTools } from '../tools/index.ts';

const RESUME_ID = process.env.SAILOR_MCP_RESUME_ID;
const USER_EMAIL = process.env.SAILOR_MCP_USER_EMAIL ?? 'local@sailor.dev';

async function resolveResumeId(userId: string): Promise<string> {
  if (RESUME_ID) return RESUME_ID;

  const resumes = await listResumes(userId);
  const first = resumes[0];
  if (!first) {
    throw new Error(
      'No resumes exist. Create one in the Sailor web app first, or set ' +
        'SAILOR_MCP_RESUME_ID to target a specific resume.',
    );
  }
  return first.id;
}

async function buildContext(): Promise<ToolContext> {
  const userId = await ensureUser(USER_EMAIL);
  const resumeId = await resolveResumeId(userId);

  return {
    userId,
    sessionId: 'mcp',
    resumeId,

    async currentVersion() {
      const version = await getCurrentVersion(resumeId);
      if (!version) throw new Error(`Resume ${resumeId} has no versions`);
      return version;
    },

    async jobTarget() {
      const id = process.env.SAILOR_MCP_JOB_ID;
      if (!id) return null;
      const row = await getJobTarget(id);
      if (!row) return null;
      return {
        id: row.id,
        company: row.company,
        role: row.role,
        description: row.description,
        sourceUrl: row.sourceUrl,
        provenance: row.provenance === 'fetched' ? 'fetched' : 'pasted',
        createdAt: row.createdAt,
      };
    },

    async requestPermission() {
      return true; // The MCP host gates. See the note at the top of this file.
    },

    async askUser(): Promise<string> {
      throw new Error(
        'Sailor cannot prompt the user over MCP. Ask your question in the chat instead, ' +
          'and do not fabricate the answer.',
      );
    },

    emitGapAnalysis(_analysis: GapAnalysis) {
      // No UI to render it into; the tool's return value carries it to the model.
    },

    async commit({ tree, summary, parentId }) {
      const outcome = await commitVersion({
        resumeId,
        tree,
        summary,
        createdBy: 'agent',
        parentId,
      });
      return {
        versionId: outcome.version.id,
        unchanged: outcome.status === 'unchanged',
      };
    },
  };
}

const ctx = await buildContext();
const tools = buildTools(ctx);

const server = new McpServer({ name: 'sailor', version: '0.1.0' });

for (const [name, definition] of Object.entries(tools)) {
  const schema = definition.inputSchema as z.ZodObject<z.ZodRawShape>;
  const execute = definition.execute;
  if (!execute) continue;

  // In AI SDK 7 a tool description may be a function of the call context. Ours
  // are all plain strings; anything else has no meaningful static text to give
  // an MCP host, so fall back to the tool name rather than inventing one.
  const description = typeof definition.description === 'string' ? definition.description : name;

  server.registerTool(name, { description, inputSchema: schema.shape }, async (input: unknown) => {
    // The AI SDK passes a second options arg; MCP does not. The tools do not
    // read it, so an empty object is honest rather than a lie about a call id.
    const output = await execute(
      input as never,
      {
        toolCallId: crypto.randomUUID(),
        messages: [],
      } as never,
    );

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
      isError: (output as { ok?: boolean })?.ok === false,
    };
  });
}

await server.connect(new StdioServerTransport());
console.error(`[sailor-mcp] ready — ${Object.keys(tools).length} tools on resume ${ctx.resumeId}`);
