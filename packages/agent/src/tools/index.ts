import type { ToolContext } from './context.ts';
import { interactTools } from './interact.ts';
import { researchTools } from './research.ts';
import { resumeTools } from './resume.ts';

export type { ToolContext } from './context.ts';
export { assertPublicUrl } from './research.ts';

/**
 * The single tool registry. Defined once, exposed twice:
 *   - in-process, to our own ACP-backed loop (loop.ts)
 *   - over MCP, to any external host (mcp/server.ts)
 *
 * Adding a tool here makes it appear on BOTH surfaces. Never fork this list —
 * a tool that exists on one surface and not the other is how the two drift.
 */
export function buildTools(ctx: ToolContext) {
  return {
    ...resumeTools(ctx),
    ...researchTools(),
    ...interactTools(ctx),
  };
}

export type SailorTools = ReturnType<typeof buildTools>;
export type SailorToolName = keyof SailorTools;

/**
 * Tools that change the resume, and therefore require human approval before they
 * run. Read-only and research tools are not gated — prompting for a web search
 * trains the user to click "allow" without reading, which is precisely what you
 * do not want them doing when the edit prompt finally appears.
 */
export const GATED_TOOLS: ReadonlySet<string> = new Set<SailorToolName>(['edit_resume']);

export const isGated = (name: string): boolean => GATED_TOOLS.has(name);
