import { describe, expect, it } from "@jest/globals";
import type { EditorView } from "@codemirror/view";
import type { Editor, TFile, WorkspaceLeaf } from "obsidian";
import {
	findCanvasEmbedEditorSurface,
	findFocusedCanvasEmbedEditorSurface,
	type CanvasEmbedNodeLike,
} from "src/editor/surfaces";

function fixture(options: { focused?: boolean; extension?: string } = {}) {
	const editorView = {
		hasFocus: options.focused ?? false,
	} as EditorView;
	const editor = { cm: editorView } as unknown as Editor;
	const file = {
		path: `Folder/note.${options.extension ?? "md"}`,
		extension: options.extension ?? "md",
	} as TFile;
	const node: CanvasEmbedNodeLike = { child: { file, editor } };
	const canvas = { nodes: new Map([["note", node]]) };
	const leaf = { view: { canvas } } as unknown as WorkspaceLeaf;
	return { editorView, editor, file, node, canvas, leaf };
}

describe("Canvas embedded-note editor surfaces", () => {
	it("resolves a whole Markdown file embed by exact CM6 ownership", () => {
		const value = fixture();
		expect(findCanvasEmbedEditorSurface([value.leaf], value.editorView)).toEqual({
			kind: "canvas-embed",
			file: value.file,
			editor: value.editor,
			editorView: value.editorView,
			leaf: value.leaf,
			canvas: value.canvas,
			node: value.node,
		});
	});

	it("does not claim an unrelated or non-Markdown child editor", () => {
		const value = fixture({ extension: "canvas" });
		expect(findCanvasEmbedEditorSurface([value.leaf], value.editorView)).toBeNull();
		expect(
			findCanvasEmbedEditorSurface([value.leaf], {} as EditorView),
		).toBeNull();
	});

	it("finds only the focused embedded-note editor for hotkey routing", () => {
		const idle = fixture();
		const focused = fixture({ focused: true });
		expect(
			findFocusedCanvasEmbedEditorSurface([idle.leaf, focused.leaf]),
		)?.toMatchObject({
			file: focused.file,
			editorView: focused.editorView,
		});
		expect(
			findFocusedCanvasEmbedEditorSurface([focused.leaf], {
				canvas: idle.canvas,
			}),
		).toBeNull();
	});
});
