import { describe, expect, it } from "@jest/globals";
import type { EditorView } from "@codemirror/view";
import type { Editor, TFile, WorkspaceLeaf } from "obsidian";
import {
	findCanvasEditorSurface,
	findFocusedCanvasEditorSurface,
	type CanvasEditorNodeLike,
} from "src/editor/surfaces";

function fixture(
	options: {
		focused?: boolean;
		embeddedExtension?: string | null;
		canvasFile?: boolean;
	} = {},
) {
	const editorView = {
		hasFocus: options.focused ?? false,
	} as EditorView;
	const editor = { cm: editorView } as unknown as Editor;
	const embeddedExtension =
		options.embeddedExtension === undefined
			? "md"
			: options.embeddedExtension;
	const embeddedFile = embeddedExtension
		? ({
				path: `Folder/note.${embeddedExtension}`,
				extension: embeddedExtension,
			}) as TFile
		: null;
	const canvasFile = options.canvasFile
		? ({ path: "Folder/board.canvas", extension: "canvas" } as TFile)
		: null;
	const node: CanvasEditorNodeLike = {
		child: { file: embeddedFile, editor },
	};
	const canvas = { nodes: new Map([["note", node]]) };
	const leaf = {
		view: { canvas, file: canvasFile },
	} as unknown as WorkspaceLeaf;
	return {
		editorView,
		editor,
		embeddedFile,
		canvasFile,
		node,
		canvas,
		leaf,
	};
}

describe("Canvas editor surfaces", () => {
	it("resolves a whole Markdown file embed by exact CM6 ownership", () => {
		const value = fixture();
		expect(findCanvasEditorSurface([value.leaf], value.editorView)).toEqual({
			kind: "canvas-embed",
			file: value.embeddedFile,
			editor: value.editor,
			editorView: value.editorView,
			leaf: value.leaf,
			canvas: value.canvas,
			node: value.node,
		});
	});

	it("resolves a native text card through its owning Canvas file", () => {
		const value = fixture({ embeddedExtension: null, canvasFile: true });
		expect(findCanvasEditorSurface([value.leaf], value.editorView)).toEqual({
			kind: "canvas-text",
			file: value.canvasFile,
			editor: value.editor,
			editorView: value.editorView,
			leaf: value.leaf,
			canvas: value.canvas,
			node: value.node,
		});
	});

	it("does not claim an unrelated or unsupported child editor", () => {
		const value = fixture({
			embeddedExtension: "canvas",
			canvasFile: true,
		});
		expect(findCanvasEditorSurface([value.leaf], value.editorView)).toBeNull();
		expect(
			findCanvasEditorSurface([value.leaf], {} as EditorView),
		).toBeNull();
	});

	it("finds only the focused Canvas editor for hotkey routing", () => {
		const idle = fixture();
		const focused = fixture({ focused: true });
		expect(
			findFocusedCanvasEditorSurface([idle.leaf, focused.leaf]),
		)?.toMatchObject({
			file: focused.embeddedFile,
			editorView: focused.editorView,
		});
		expect(
			findFocusedCanvasEditorSurface([focused.leaf], {
				canvas: idle.canvas,
			}),
		).toBeNull();
	});
});
