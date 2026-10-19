import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, type DecorationSet, type WidgetType } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { createReviewEditorExtension, type ReviewEditorController } from "src/editor/extension";

jest.mock("obsidian", () => {
	const { StateField } = jest.requireActual<typeof import("@codemirror/state")>("@codemirror/state");
	return {
		editorInfoField: StateField.define({ create: () => null, update: v => v }),
		editorLivePreviewField: StateField.define({ create: () => true, update: v => v }),
	};
}, { virtual: true });

function owner() {
	const getDisplayMode = jest.fn(() => "review" as const);
	return { getDisplayMode, controller: { getDisplayMode } as ReviewEditorController };
}

function decorations(state: EditorState): DecorationSet[] {
	return state.facet(EditorView.decorations) as DecorationSet[];
}

test("removal preserves the document, selection and another extension's state", () => {
	const plugin = owner();
	const handle = createReviewEditorExtension(plugin.controller);
	const foreignValue = { provider: "another plugin" };
	const foreign = StateField.define({ create: () => foreignValue, update: v => v });
	const state = EditorState.create({
		doc: "{==text==}{>>comment<<}", selection: { anchor: 5 },
		extensions: [editorLivePreviewField, foreign, handle.extension],
	});
	expect(decorations(state).some(set => set.size > 0)).toBe(true);
	const removed = state.update({ effects: StateEffect.reconfigure.of([foreign]) }).state;
	handle.dispose();
	handle.dispose();
	expect(removed.doc).toBe(state.doc);
	expect(removed.selection).toBe(state.selection);
	expect(removed.field(foreign)).toBe(foreignValue);
	expect(decorations(removed)).toEqual([]);
	plugin.getDisplayMode.mockClear();
	expect(removed.update({ changes: { from: 0, insert: "x" } }).state.doc.length).toBe(state.doc.length + 1);
	expect(plugin.getDisplayMode).not.toHaveBeenCalled();
});

test("disposing retained task widgets disconnects their methods and leaves a new load working", () => {
	const old = createReviewEditorExtension(owner().controller);
	const doc = "{++- [ ] task++}";
	const state = EditorState.create({ doc, extensions: [editorLivePreviewField, old.extension] });
	const widgets: WidgetType[] = [];
	for (const set of decorations(state)) {
		for (let cursor = set.iter(); cursor.value; cursor.next()) {
			if (cursor.value.spec.widget) widgets.push(cursor.value.spec.widget);
		}
	}
	expect(widgets).toHaveLength(1);
	expect(widgets[0].eq(widgets[0])).toBe(true);
	state.update({ effects: StateEffect.reconfigure.of([]) });
	old.dispose();
	expect(widgets[0].eq(widgets[0])).toBeUndefined();
	const current = owner();
	const next = createReviewEditorExtension(current.controller);
	const fresh = EditorState.create({ doc, extensions: [editorLivePreviewField, next.extension] });
	expect(decorations(fresh).some(set => set.size > 0)).toBe(true);
	expect(current.getDisplayMode).toHaveBeenCalled();
	next.dispose();
});
