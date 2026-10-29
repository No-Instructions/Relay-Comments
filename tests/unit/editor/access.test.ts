import { describe, expect, it } from "@jest/globals";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorAccessChanged, isEditorReadOnly } from "src/editor/access";

describe("isEditorReadOnly", () => {
	it("is false for an ordinary editor state", () => {
		expect(isEditorReadOnly({ state: EditorState.create({ doc: "text" }) })).toBe(false);
	});

	it("honours the readOnly facet", () => {
		const state = EditorState.create({
			doc: "text",
			extensions: [EditorState.readOnly.of(true)],
		});
		expect(isEditorReadOnly({ state })).toBe(true);
	});

	it("honours a non-editable view", () => {
		// Relay sets both facets for a note in a read-only folder.
		const state = EditorState.create({
			doc: "text",
			extensions: [EditorView.editable.of(false)],
		});
		expect(isEditorReadOnly({ state })).toBe(true);
	});
});

describe("editorAccessChanged", () => {
	it("detects permission revocation and restoration without a document edit", () => {
		const access = new Compartment();
		const writable = EditorState.create({ doc: "unchanged", extensions: [access.of([])] });
		const locked = writable.update({ effects: access.reconfigure(EditorState.readOnly.of(true)) }).state;
		expect(locked.doc).toBe(writable.doc);
		expect(editorAccessChanged(writable, locked)).toBe(true);
		const restored = locked.update({ effects: access.reconfigure([]) }).state;
		expect(editorAccessChanged(locked, restored)).toBe(true);
	});

	it("treats both host permission facets as the same read-only state", () => {
		const access = new Compartment();
		const locked = EditorState.create({ extensions: [access.of(EditorState.readOnly.of(true))] });
		const nonEditable = locked.update({ effects: access.reconfigure(EditorView.editable.of(false)) }).state;
		expect(editorAccessChanged(locked, nonEditable)).toBe(false);
	});

	it("does not signal a permission change for ordinary document edits", () => {
		const before = EditorState.create({ doc: "before" });
		const after = before.update({ changes: { from: 0, insert: "edit " } }).state;
		expect(editorAccessChanged(before, after)).toBe(false);
	});
});
