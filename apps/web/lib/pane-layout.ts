export type PaneWidths = { source: number; preview: number; agent: number };
export type PaneBoundary = 'source' | 'agent';
export type WorkbenchPane = 'source' | 'preview' | 'agent';

export const PANE_HANDLE_WIDTH = 6;
export const PANE_MIN = { source: 240, preview: 280, agent: 300 } as const;
export const WORKBENCH_PANES: readonly WorkbenchPane[] = ['source', 'preview', 'agent'];

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export function movePaneTab(current: WorkbenchPane, direction: -1 | 1): WorkbenchPane {
  const index = WORKBENCH_PANES.indexOf(current);
  return (
    WORKBENCH_PANES[(index + direction + WORKBENCH_PANES.length) % WORKBENCH_PANES.length] ??
    current
  );
}

export function parsePaneWidths(raw: string | null): PaneWidths | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    if (!('source' in value) || !('preview' in value) || !('agent' in value)) return null;
    if (
      typeof value.source !== 'number' ||
      typeof value.preview !== 'number' ||
      typeof value.agent !== 'number' ||
      !Number.isFinite(value.source) ||
      !Number.isFinite(value.preview) ||
      !Number.isFinite(value.agent) ||
      value.source <= 0 ||
      value.preview <= 0 ||
      value.agent <= 0
    )
      return null;
    return { source: value.source, preview: value.preview, agent: value.agent };
  } catch {
    return null;
  }
}

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
