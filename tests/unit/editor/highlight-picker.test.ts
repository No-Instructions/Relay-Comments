import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { editorLivePreviewField, requireApiVersion } from "obsidian";
import { createReviewEditorExtension, type ReviewEditorController } from "src/editor/extension";

jest.mock("obsidian", () => {
	const { StateField } = jest.requireActual<typeof import("@codemirror/state")>("@codemirror/state");
	return {
		requireApiVersion: jest.fn(),
		editorInfoField: StateField.define({ create: () => null, update: v => v }),
		editorLivePreviewField: StateField.define({ create: () => true, update: v => v }),
	};
}, { virtual: true });

const apiCheck = jest.mocked(requireApiVersion);
const source = "{==🔵 passage==}{>>Keep this comment.<<}";

function fixture(doc = source, access = new Compartment()) {
	const handle = createReviewEditorExtension({
		getDisplayMode: () => "review",
	} as ReviewEditorController);
	const state = EditorState.create({
		doc,
		extensions: [editorLivePreviewField, access.of([]), handle.extension],
	});
	return { handle, state, access };
}

/** The native swatch is covered if Comments replaces any part of its emoji. */
function replaces(state: EditorState, from: number, to: number): boolean {
	for (const set of state.facet(EditorView.decorations) as DecorationSet[]) {
		for (let cursor = set.iter(); cursor.value; cursor.next()) {
			if (cursor.value.spec.block === false && cursor.from < to && cursor.to > from) return true;
		}
	}
	return false;
}

beforeEach(() => apiCheck.mockReset());

test("keeps markers hidden when the host predates the native picker", () => {
	apiCheck.mockReturnValue(false);
	const { handle, state } = fixture();
	expect(apiCheck).toHaveBeenCalledWith("1.14.0");
	expect(replaces(state, 3, 5)).toBe(true);
	expect(state.doc.toString()).toBe(source);
	handle.dispose();
});

test("leaves the native swatch range free while hiding delimiters, spacer and comment", () => {
	apiCheck.mockReturnValue(true);
	const { handle, state } = fixture();
	expect(replaces(state, 3, 5)).toBe(false);
	expect(replaces(state, 0, 3)).toBe(true);
	expect(replaces(state, 5, 6)).toBe(true);
	expect(replaces(state, source.indexOf("{>>"), source.length)).toBe(true);
	expect(state.doc.toString()).toBe(source);
	handle.dispose();
});

test.each([EditorState.readOnly.of(true), EditorView.editable.of(false)])(
	"withdraws the swatch on access revocation and restores it without a document edit",
	(readOnly) => {
		apiCheck.mockReturnValue(true);
		const { handle, state, access } = fixture();
		const locked = state.update({ effects: access.reconfigure(readOnly) }).state;
		expect(replaces(locked, 3, 5)).toBe(true);
		const unlocked = locked.update({ effects: access.reconfigure([]) }).state;
		expect(replaces(unlocked, 3, 5)).toBe(false);
		expect(unlocked.doc).toBe(state.doc);
		handle.dispose();
	},
);

test("also withdraws the native swatch on a read-only native comment anchor", () => {
	apiCheck.mockReturnValue(true);
	const { handle, state, access } = fixture("==🔵passage=={>>comment<<}");
	expect(replaces(state, 2, 4)).toBe(false);
	const locked = state.update({ effects: access.reconfigure(EditorState.readOnly.of(true)) }).state;
	expect(replaces(locked, 2, 4)).toBe(true);
	handle.dispose();
});

test("does not expose a color control in Source mode", () => {
	apiCheck.mockReturnValue(true);
	const handle = createReviewEditorExtension({ getDisplayMode: () => "review" } as ReviewEditorController);
	const state = EditorState.create({ doc: source, extensions: [handle.extension] });
	expect((state.facet(EditorView.decorations) as DecorationSet[]).every(set => set.size === 0)).toBe(true);
	handle.dispose();
});

test.each([source, "==🔵 passage=={>>comment<<}"])(
	"blocks a pending native picker edit after revocation but still accepts remote changes: %s",
	(doc) => {
		apiCheck.mockReturnValue(true);
		const { handle, state, access } = fixture(doc);
		const locked = state.update({ effects: access.reconfigure(EditorState.readOnly.of(true)) }).state;
		const from = doc.indexOf("🔵");
		const changes = { from, to: from + 2, insert: "🟢" };
		expect(locked.update({ changes, userEvent: "input.type" }).state.doc.toString()).toBe(doc);
		expect(locked.update({ changes: { ...changes, insert: "" }, userEvent: "input.type" }).state.doc.toString()).toBe(doc);
		expect(locked.update({ changes }).state.doc.toString()).toBe(doc.replace("🔵", "🟢"));
		expect(locked.update({ changes, userEvent: "input.type", annotations: Transaction.remote.of(true) }).state.doc.toString()).toBe(doc.replace("🔵", "🟢"));
		const unlocked = locked.update({ effects: access.reconfigure([]) }).state;
		expect(unlocked.update({ changes, userEvent: "input.type" }).state.doc.toString()).toBe(doc.replace("🔵", "🟢"));
		handle.dispose();
	},
);

test("a remote reset to Default cannot let the pending menu reinsert a color while read-only", () => {
	apiCheck.mockReturnValue(true);
	const { handle, state, access } = fixture();
	const locked = state.update({ effects: access.reconfigure(EditorState.readOnly.of(true)) }).state;
	const reset = locked.update({ changes: { from: 3, to: 5, insert: "" } }).state;
	const recolored = reset.update({ changes: { from: 3, insert: "🟢" }, userEvent: "input.type" }).state;
	expect(recolored.doc).toBe(reset.doc);
	handle.dispose();
});
