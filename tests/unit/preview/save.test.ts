import { describe, expect, it, jest } from "@jest/globals";
import type { Editor, MarkdownView } from "obsidian";
import { EditorState, Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syncEditorFromReadingMode, syncReadingModeAfterEdit } from "src/preview/save";

describe("syncEditorFromReadingMode", () => {
	it("maps an external insertion without making it an undoable user edit", () => {
		let state = EditorState.create({ doc: "before after", selection: { anchor: 9 } });
		const transactions: Transaction[] = [];
		const cm = {
			get state() { return state; },
			dispatch(spec: Parameters<EditorState["update"]>[0]) {
				const tr = state.update(spec);
				transactions.push(tr);
				state = tr.state;
			},
		} as Pick<EditorView, "state" | "dispatch">;
		const view = { getMode: () => "preview", previewMode: { get: () => "before external after" } } as MarkdownView;
		syncEditorFromReadingMode(view, cm);
		expect(state.doc.toString()).toBe("before external after");
		expect(state.selection.main.anchor).toBe(18);
		expect(transactions[0].annotation(Transaction.addToHistory)).toBe(false);
		expect(transactions[0].annotation(Transaction.userEvent)).toBe("set");
		syncEditorFromReadingMode(view, cm);
		expect(transactions).toHaveLength(1);
	});
});

function fixture(mode: "source" | "preview" = "preview", oldText = "Before") {
	const editor = { getValue: () => "After" } as Editor;
	let preview = oldText;
	const set = jest.fn((text: string, clear: boolean) => {
		expect(clear).toBe(false);
		preview = text;
	});
	const saved: string[] = [];
	const requestSave = jest.fn(() => { saved.push(preview); });
	const view = {
		editor, getMode: () => mode,
		previewMode: { get: () => preview, set }, requestSave,
	} as unknown as MarkdownView;
	return { view, editor, set, requestSave, saved };
}

describe("syncReadingModeAfterEdit", () => {
	it("makes the edited text the active Reading view's save source", () => {
		const f = fixture();
		syncReadingModeAfterEdit(f.view, f.editor);
		expect(f.saved).toEqual(["After"]);
		expect(f.view.editor).toBe(f.editor);
	});

	it("leaves the host's normal source-mode save path alone", () => {
		const f = fixture("source");
		syncReadingModeAfterEdit(f.view, f.editor);
		expect(f.set).not.toHaveBeenCalled();
		expect(f.requestSave).not.toHaveBeenCalled();
	});

	it("does not copy an edit into another note's view", () => {
		const f = fixture();
		syncReadingModeAfterEdit(f.view, { getValue: () => "Wrong note" } as Editor);
		expect(f.set).not.toHaveBeenCalled();
	});

	it("does not rerender or schedule saves when the preview already agrees", () => {
		const f = fixture("preview", "After");
		syncReadingModeAfterEdit(f.view, f.editor);
		expect(f.set).not.toHaveBeenCalled();
		expect(f.requestSave).not.toHaveBeenCalled();
	});
});
