import type { GapAnalysis, JobTarget, ResumeVersion } from '@sailor/core';

/**
 * Everything a tool is allowed to reach. Tools get this and nothing else — no
 * ambient db handle, no ambient socket. That is what makes them testable and
 * what lets the same tool body run under our ACP loop and under an MCP host.
 */
export type ToolContext = {
  userId: string;
  sessionId: string;
  resumeId: string;

  /** Current tip of the resume. Re-read per call — the user may have edited it. */
  currentVersion(): Promise<ResumeVersion>;
  jobTarget(): Promise<JobTarget | null>;

  /**
   * Ask the client to approve a mutating action. Resolves true if approved.
   *
   * Under ACP this becomes `session/request_permission` and blocks on the human.
   * Under an MCP host it returns true, because the host runs its own approval UI
   * and double-prompting is worse than not prompting.
   */
  requestPermission(request: {
    toolName: string;
    title: string;
    /** A unified diff when the action changes the resume, so the human sees exactly what. */
    diff?: string;
  }): Promise<boolean>;

  /**
   * Ask the human a question and block for the answer. This is the mechanism
   * behind invariant 1: when the agent wants a metric it does not have, it MUST
   * come here rather than invent one.
   */
  askUser(question: string): Promise<string>;

  /** Structured artifacts the UI renders alongside the chat. */
  emitGapAnalysis(analysis: GapAnalysis): void;

  /** Commit a new resume version. Returns the new version id. */
  commit(args: {
    tree: ResumeVersion['tree'];
    summary: string;
    parentId: string;
  }): Promise<{ versionId: string; unchanged: boolean }>;
};
