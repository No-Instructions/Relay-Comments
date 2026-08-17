import { describe, expect, it } from "@jest/globals";
import {
	isSelectionTrusted,
	selectionTrust,
	type DomSelectionFacts,
} from "src/editor/selection-trust";

function facts(overrides: Partial<DomSelectionFacts> = {}): DomSelectionFacts {
	return {
		domText: "Some prose",
		insideContent: true,
		anchorEditable: "true",
		focusEditable: "true",
		stateText: "Some prose",
		...overrides,
	};
}

describe("selection trust", () => {
	it("trusts a selection the editor and the document agree on", () => {
		expect(selectionTrust(facts())).toBe("trusted");
		expect(isSelectionTrusted(facts())).toBe(true);
	});

	it("distrusts a selection inside an uneditable widget", () => {
		// Obsidian renders tables as contenteditable="false" widgets. Selecting in one produces no
		// CodeMirror transaction, so state.selection still describes the previous selection - the
		// case that wrote a comment into the first characters of a document.
		expect(
			selectionTrust(
				facts({
					domText: "1.8.26",
					anchorEditable: "false",
					focusEditable: "false",
					stateText: "Some prose",
				}),
			),
		).toBe("uneditable-widget");
	});

	it("distrusts a selection with one end in a widget", () => {
		expect(
			selectionTrust(facts({ focusEditable: "false", domText: "Some prose" })),
		).toBe("uneditable-widget");
	});

	it("distrusts a stale range even without a contenteditable signal", () => {
		// The text comparison is the backstop: a widget that reports no contenteditable at all
		// still cannot make the two texts agree.
		expect(
			selectionTrust(
				facts({
					domText: "1.8.26",
					anchorEditable: null,
					focusEditable: null,
					stateText: "Some prose",
				}),
			),
		).toBe("text-mismatch");
	});

	it("ignores whitespace differences between rendered and source text", () => {
		// A rendered selection legitimately collapses and re-wraps whitespace.
		expect(
			selectionTrust(
				facts({ domText: "two  words\n", stateText: "two words" }),
			),
		).toBe("trusted");
	});

	it("distrusts a selection outside the editor content", () => {
		expect(selectionTrust(facts({ insideContent: false }))).toBe(
			"outside-editor",
		);
	});

	it("distrusts the absence of a document selection", () => {
		expect(selectionTrust(facts({ domText: null }))).toBe("no-dom-selection");
	});
});
