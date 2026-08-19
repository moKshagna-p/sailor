export type PaneWidths = { source: number; preview: number; agent: number };
export type PaneBoundary = 'source' | 'agent';

export const PANE_HANDLE_WIDTH = 6;
export const PANE_MIN = { source: 240, preview: 280, agent: 300 } as const;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function resizePaneLayout(
  containerWidth: number,
  current: PaneWidths,
  boundary: PaneBoundary,
  pointerX: number,
): PaneWidths {
  const available = containerWidth - PANE_HANDLE_WIDTH * 2;
  const agent = clamp(
    current.agent,
    PANE_MIN.agent,
    available - PANE_MIN.source - PANE_MIN.preview,
  );
  const source = clamp(current.source, PANE_MIN.source, available - PANE_MIN.preview - agent);

  if (boundary === 'source') {
    const nextSource = clamp(pointerX, PANE_MIN.source, available - PANE_MIN.preview - agent);
    return { source: nextSource, preview: available - nextSource - agent, agent };
  }

  const nextAgent = clamp(
    containerWidth - pointerX,
    PANE_MIN.agent,
    available - source - PANE_MIN.preview,
  );
  return { source, preview: available - source - nextAgent, agent: nextAgent };
}
