import type { EditorView } from "@codemirror/view";
import type { Editor, TFile, WorkspaceLeaf } from "obsidian";

type EditorWithCodeMirror = Editor & { cm?: EditorView };

interface CanvasEditorChildLike {
	file?: TFile | null;
	editor?: EditorWithCodeMirror;
}

export interface CanvasEditorNodeLike {
	child?: CanvasEditorChildLike;
	nodeEl?: HTMLElement;
}

export interface CanvasLike {
	nodes?: Map<string, CanvasEditorNodeLike>;
	selectOnly?: (node: CanvasEditorNodeLike) => void;
	zoomToSelection?: () => void;
}

export interface CanvasViewLike {
	canvas?: CanvasLike;
	file?: TFile | null;
}

export interface CanvasEditorSurface {
	kind: "canvas-embed" | "canvas-text";
	file: TFile;
	editor: Editor;
	editorView: EditorView;
	leaf: WorkspaceLeaf;
	canvas: CanvasLike;
	node: CanvasEditorNodeLike;
}

/**
 * Find the Canvas node that owns an exact CM6 editor.
 *
 * Canvas file embeds and native text cards are not workspace MarkdownView
 * leaves, and their editorInfoField can be empty. The node's child is the
 * authoritative owner. Exact editor identity also keeps fragment editors
 * (tables, hover previews, footnotes) out: none of those is a Canvas node's
 * own child editor.
 */
export function findCanvasEditorSurface(
	leaves: readonly WorkspaceLeaf[],
	editorView: EditorView,
): CanvasEditorSurface | null {
	return (
		listCanvasEditorSurfaces(leaves).find(
			(surface) => surface.editorView === editorView,
		) ?? null
	);
}

export function listCanvasEditorSurfaces(
	leaves: readonly WorkspaceLeaf[],
): CanvasEditorSurface[] {
	const surfaces: CanvasEditorSurface[] = [];
	for (const leaf of leaves) {
		const view = leaf.view as unknown as CanvasViewLike;
		const canvas = view.canvas;
		if (!canvas?.nodes) continue;
		for (const node of canvas.nodes.values()) {
			const child = node.child;
			if (!child?.editor?.cm) continue;
			const embeddedFile =
				child.file?.extension === "md" ? child.file : null;
			const canvasFile =
				child.file == null && view.file?.extension === "canvas" ? view.file : null;
			const file = embeddedFile ?? canvasFile;
			if (!file) continue;
			surfaces.push({
				kind: embeddedFile ? "canvas-embed" : "canvas-text",
				file,
				editor: child.editor,
				editorView: child.editor.cm,
				leaf,
				canvas,
				node,
			});
		}
	}
	return surfaces;
}

export function findFocusedCanvasEditorSurface(
	leaves: readonly WorkspaceLeaf[],
	owner?: CanvasViewLike | null,
): CanvasEditorSurface | null {
	return (
		listCanvasEditorSurfaces(leaves).find(
			(surface) =>
				surface.editorView.hasFocus &&
				(!owner?.canvas || surface.canvas === owner.canvas),
		) ?? null
	);
}
