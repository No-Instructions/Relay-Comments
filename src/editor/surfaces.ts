import type { EditorView } from "@codemirror/view";
import type { Editor, TFile, WorkspaceLeaf } from "obsidian";

type EditorWithCodeMirror = Editor & { cm?: EditorView };

interface CanvasEmbedChildLike {
	file?: TFile | null;
	editor?: EditorWithCodeMirror;
}

export interface CanvasEmbedNodeLike {
	child?: CanvasEmbedChildLike;
	nodeEl?: HTMLElement;
}

export interface CanvasLike {
	nodes?: Map<string, CanvasEmbedNodeLike>;
	selectOnly?: (node: CanvasEmbedNodeLike) => void;
	zoomToSelection?: () => void;
}

export interface CanvasViewLike {
	canvas?: CanvasLike;
}

export interface CanvasEmbedEditorSurface {
	kind: "canvas-embed";
	file: TFile;
	editor: Editor;
	editorView: EditorView;
	leaf: WorkspaceLeaf;
	canvas: CanvasLike;
	node: CanvasEmbedNodeLike;
}

/**
 * Find the whole-note Canvas file embed that owns an exact CM6 editor.
 *
 * Canvas file-node editors are not workspace MarkdownView leaves, and their
 * editorInfoField can be empty. The node's child is the authoritative owner.
 * Exact editor identity also keeps fragment editors (tables, hover previews,
 * footnotes) out: none of those is a Canvas node's own child editor.
 */
export function findCanvasEmbedEditorSurface(
	leaves: readonly WorkspaceLeaf[],
	editorView: EditorView,
): CanvasEmbedEditorSurface | null {
	return (
		listCanvasEmbedEditorSurfaces(leaves).find(
			(surface) => surface.editorView === editorView,
		) ?? null
	);
}

export function listCanvasEmbedEditorSurfaces(
	leaves: readonly WorkspaceLeaf[],
): CanvasEmbedEditorSurface[] {
	const surfaces: CanvasEmbedEditorSurface[] = [];
	for (const leaf of leaves) {
		const canvas = (leaf.view as unknown as CanvasViewLike).canvas;
		if (!canvas?.nodes) continue;
		for (const node of canvas.nodes.values()) {
			const child = node.child;
			if (
				!child?.editor?.cm ||
				!child.file ||
				child.file.extension !== "md"
			) {
				continue;
			}
			surfaces.push({
				kind: "canvas-embed",
				file: child.file,
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

export function findFocusedCanvasEmbedEditorSurface(
	leaves: readonly WorkspaceLeaf[],
	owner?: CanvasViewLike | null,
): CanvasEmbedEditorSurface | null {
	return (
		listCanvasEmbedEditorSurfaces(leaves).find(
			(surface) =>
				surface.editorView.hasFocus &&
				(!owner?.canvas || surface.canvas === owner.canvas),
		) ?? null
	);
}
