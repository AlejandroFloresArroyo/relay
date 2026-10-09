/**
 * The tools of one Servidor on screen (docs/planning/relay-v3-workspace-outline.md): one tool on a
 * phone; on a wide window one or two panels. Each tool lives in one panel at most, and the focused
 * panel is the only one that receives the keyboard.
 */
export type WorkspaceTool = 'terminal' | 'files' | 'web' | 'browser';
export type PanelIndex = 0 | 1;
export interface Workspace {
  /** The tool of each panel; always two different tools, so a second panel never repeats the first. */
  readonly tools: readonly [WorkspaceTool, WorkspaceTool];
  /** Two panels asked for; shown only while the window is wide enough. */
  readonly split: boolean;
  readonly focus: PanelIndex;
}
export interface Placement { panel: PanelIndex; side: 'full' | 'left' | 'right' }

export const WORKSPACE_START: Workspace = { tools: ['terminal', 'files'], split: false, focus: 0 };

const other = (panel: PanelIndex): PanelIndex => (panel === 0 ? 1 : 0);

export function workspacePanels(w: Workspace, wide: boolean): PanelIndex[] {
  return wide && w.split ? [0, 1] : [w.focus];
}

/** Where a tool shows now, or null while it waits out of view (still mounted, keeping its work). */
export function placeTool(w: Workspace, wide: boolean, tool: WorkspaceTool): Placement | null {
  const panels = workspacePanels(w, wide);
  const panel = panels.find((each) => w.tools[each] === tool);
  if (panel === undefined) return null;
  return { panel, side: panels.length === 1 ? 'full' : panel === 0 ? 'left' : 'right' };
}

export function focusPanel(w: Workspace, panel: PanelIndex): Workspace {
  return w.focus === panel ? w : { ...w, focus: panel };
}

export function splitWorkspace(w: Workspace, split: boolean): Workspace {
  return w.split === split ? w : { ...w, split };
}

/** A tool chosen in a panel; if the other panel held it, the two swap. */
export function pickTool(w: Workspace, panel: PanelIndex, tool: WorkspaceTool): Workspace {
  const tools: [WorkspaceTool, WorkspaceTool] = [...w.tools];
  if (tools[other(panel)] === tool) tools[other(panel)] = tools[panel];
  tools[panel] = tool;
  return { ...w, tools, focus: panel };
}

/** A tool asked for by the focused one («Terminal aquí», «Navegador del Servidor»): shown beside it when two panels show. */
export function revealTool(w: Workspace, wide: boolean, tool: WorkspaceTool): Workspace {
  const placed = placeTool(w, wide, tool);
  if (placed) return focusPanel(w, placed.panel);
  return pickTool(w, workspacePanels(w, wide).length === 2 ? other(w.focus) : w.focus, tool);
}
