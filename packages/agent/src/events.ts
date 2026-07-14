import type { GapAnalysis } from '@sailor/core';

/**
 * What a turn emits. This is the agent's public event vocabulary — the ACP
 * bridge maps these onto `session/update` notifications, and nothing else in the
 * system needs to know what an "AI SDK stream part" is.
 */
export type AgentEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; callId: string; name: string; input: unknown }
  | {
      type: 'tool_end';
      callId: string;
      name: string;
      ok: boolean;
      output: unknown;
    }
  /** The resume changed. The UI reloads the editor and re-renders the PDF. */
  | {
      type: 'version_committed';
      versionId: string;
      summary: string;
      diff: string;
    }
  | { type: 'gap_analysis'; analysis: GapAnalysis }
  | {
      type: 'turn_end';
      stopReason: 'end_turn' | 'max_steps' | 'error' | 'cancelled';
    }
  | { type: 'error'; message: string };

export type AgentEventSink = (event: AgentEvent) => void;
