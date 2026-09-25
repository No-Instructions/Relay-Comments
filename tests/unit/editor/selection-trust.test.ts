import { describe, expect, it } from "@jest/globals";
import {
	editorSelectionTrust,
	isEditorSelectionTrusted,
	isFragmentEditor,
	isSelectionTrusted,
	readDomSelectionFacts,
	selectionTrust,
	type DomElementLike,
	type DomNodeLike,
	type DomSelectionFacts,
	type DomSelectionLike,
	type TrustableEditorView,
} from "src/editor/selection-trust";

function facts(overrides: Partial<DomSelectionFacts> = {}): DomSelectionFacts {
	return {
		domText: "Some prose",
		endsInsideContent: 2,
		anchorEditable: "true",
		focusEditable: "true",
		stateText: "Some prose",
		...overrides,
	};
}

describe("selection trust", () => {
	it("trusts a selection the editor and the document agree on", () => {
		expect(selectionTrust(facts())).toBe("agrees");
		expect(isSelectionTrusted(facts())).toBe(true);
	});

	it("distrusts a selection inside an uneditable widget", () => {
		// A widget selection leaves state.selection on the previous range.
		const widget = facts({
			domText: "1.8.26",
			anchorEditable: "false",
			focusEditable: "false",
			stateText: "Some prose",
		});
		expect(selectionTrust(widget)).toBe("uneditable-widget");
		expect(isSelectionTrusted(widget)).toBe(false);
	});

	it("distrusts a selection with one end in a widget", () => {
		expect(
			selectionTrust(facts({ focusEditable: "false", domText: "Some prose" })),
		).toBe("uneditable-widget");
	});

	it("distrusts a stale range even without a contenteditable signal", () => {
		// The text comparison is the backstop when no contenteditable signal exists.
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

	it("distrusts a document selection that collapsed inside the editor", () => {
		// The document says nothing is selected here any more, whatever the state remembers.
		expect(selectionTrust(facts({ domText: "" }))).toBe("text-mismatch");
	});

	it("ignores whitespace differences between rendered and source text", () => {
		// A rendered selection legitimately collapses and re-wraps whitespace.
		expect(
			selectionTrust(
				facts({ domText: "two  words\n", stateText: "two words" }),
			),
		).toBe("agrees");
	});

	it("keeps trusting the state selection when the document selection is elsewhere", () => {
		// CodeMirror keeps its selection while blurred, so a sidebar click must not disable the button.
		const elsewhere = facts({
			domText: "a sidebar comment",
			endsInsideContent: 0,
			anchorEditable: null,
			focusEditable: null,
		});
		expect(selectionTrust(elsewhere)).toBe("outside-editor");
		expect(isSelectionTrusted(elsewhere)).toBe(true);
	});

	it("keeps trusting the state selection when the document has no selection", () => {
		const none = facts({
			domText: null,
			endsInsideContent: 0,
			anchorEditable: null,
			focusEditable: null,
		});
		expect(selectionTrust(none)).toBe("no-dom-selection");
		expect(isSelectionTrusted(none)).toBe(true);
	});

	it("distrusts a selection dragged across the editor's edge", () => {
		// A drag from the sidebar into the note leaves the state stale with nothing to compare.
		const straddling = facts({
			domText: "comment text\nClosing paragraph",
			endsInsideContent: 1,
			anchorEditable: null,
			focusEditable: "true",
		});
		expect(selectionTrust(straddling)).toBe("partly-outside");
		expect(isSelectionTrusted(straddling)).toBe(false);
	});

	it("reports a widget end before the straddling verdict", () => {
		expect(
			selectionTrust(
				facts({ endsInsideContent: 1, anchorEditable: null, focusEditable: "false" }),
			),
		).toBe("uneditable-widget");
	});
});

// A minimal DOM: enough of Node/Element for the helpers, without a browser.
class FakeElement implements DomElementLike {
	nodeType = 1;
	parentElement: FakeElement | null = null;
	children: Array<FakeElement | FakeText> = [];

	constructor(
		private classes: string[] = [],
		private attributes: Record<string, string> = {},
	) {}

	append(...children: Array<FakeElement | FakeText>): this {
		for (const child of children) {
			child.parentElement = this;
			this.children.push(child);
		}
		return this;
	}

	text(value: string): FakeText {
		const node = new FakeText(value);
		this.append(node);
		return node;
	}

	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null;
	}

	closest(selector: string): FakeElement | null {
		let current: FakeElement | null = this;
		while (current) {
			if (current.matches(selector)) return current;
			current = current.parentElement;
		}
		return null;
	}

	contains(node: DomNodeLike | null): boolean {
		let current: DomNodeLike | null = node;
		while (current) {
			if (current === this) return true;
			current = current.parentElement;
		}
		return false;
	}

	private matches(selector: string): boolean {
		if (selector.startsWith(".")) return this.classes.includes(selector.slice(1));
		if (selector === "[contenteditable]") return "contenteditable" in this.attributes;
		throw new Error(`unsupported selector in fake DOM: ${selector}`);
	}
}

class FakeText implements DomNodeLike {
	nodeType = 3;
	parentElement: FakeElement | null = null;
	constructor(public data: string) {}
}

function selectionOver(
	start: DomNodeLike,
	end: DomNodeLike,
	text: string,
): DomSelectionLike {
	return {
		rangeCount: 1,
		getRangeAt: () => ({ startContainer: start, endContainer: end }),
		toString: () => text,
	};
}

/** An editable content element, a contenteditable=false callout inside it, and a sidebar outside. */
function livePreviewFixture() {
	const editor = new FakeElement(["cm-editor"]);
	const content = new FakeElement(["cm-content"], { contenteditable: "true" });
	const line = new FakeElement(["cm-line"]);
	const prose = line.text("Some prose before the callout.");
	const callout = new FakeElement(["cm-embed-block", "cm-callout"], {
		contenteditable: "false",
	});
	const calloutText = new FakeElement(["callout-content"]).text("Callout body");
	callout.append(calloutText.parentElement!);
	content.append(line, callout);
	editor.append(content);
	const sidebar = new FakeElement(["critic-sidebar"]);
	const comment = sidebar.text("a sidebar comment");
	new FakeElement(["workspace"]).append(editor, sidebar);
	return { editor, content, prose, calloutText, comment };
}

describe("readDomSelectionFacts", () => {
	it("reads a prose selection as editable and inside the content", () => {
		const { content, prose } = livePreviewFixture();
		const facts = readDomSelectionFacts(
			selectionOver(prose, prose, "Some prose"),
			content,
			"Some prose",
		);
		expect(facts).toEqual({
			domText: "Some prose",
			endsInsideContent: 2,
			anchorEditable: "true",
			focusEditable: "true",
			stateText: "Some prose",
		});
		expect(selectionTrust(facts)).toBe("agrees");
	});

	it("reads a callout selection as an uneditable widget of this editor", () => {
		const { content, calloutText } = livePreviewFixture();
		const facts = readDomSelectionFacts(
			selectionOver(calloutText, calloutText, "Callout body"),
			content,
			"Some prose",
		);
		expect(facts.endsInsideContent).toBe(2);
		expect(facts.anchorEditable).toBe("false");
		expect(facts.focusEditable).toBe("false");
		expect(selectionTrust(facts)).toBe("uneditable-widget");
	});

	it("reads a sidebar selection as outside the editor", () => {
		const { content, comment } = livePreviewFixture();
		const facts = readDomSelectionFacts(
			selectionOver(comment, comment, "a sidebar comment"),
			content,
			"Some prose",
		);
		expect(facts.endsInsideContent).toBe(0);
		expect(facts.anchorEditable).toBeNull();
		expect(facts.focusEditable).toBeNull();
		expect(selectionTrust(facts)).toBe("outside-editor");
	});

	it("reads a selection straddling the editor edge as partly outside", () => {
		const { content, comment, prose } = livePreviewFixture();
		const facts = readDomSelectionFacts(
			selectionOver(comment, prose, "a sidebar comment\nSome prose"),
			content,
			"Some prose",
		);
		expect(facts.endsInsideContent).toBe(1);
		expect(facts.anchorEditable).toBeNull();
		expect(facts.focusEditable).toBe("true");
		expect(selectionTrust(facts)).toBe("partly-outside");
	});

	it("reads the absence of a selection", () => {
		const { content } = livePreviewFixture();
		const empty: DomSelectionLike = {
			rangeCount: 0,
			getRangeAt: () => {
				throw new Error("no ranges");
			},
			toString: () => "",
		};
		expect(readDomSelectionFacts(empty, content, "Some prose").domText).toBeNull();
		expect(readDomSelectionFacts(null, content, "Some prose").domText).toBeNull();
	});

	it("accepts element containers as well as text nodes", () => {
		const { content, editor } = livePreviewFixture();
		// A selection anchored on the content element itself (e.g. a triple-click) is inside.
		expect(
			readDomSelectionFacts(selectionOver(content, content, ""), content, "")
				.endsInsideContent,
		).toBe(2);
		// The editor element wraps the content; anchoring there is outside the content.
		expect(
			readDomSelectionFacts(selectionOver(editor, editor, ""), content, "")
				.endsInsideContent,
		).toBe(0);
	});
});

describe("isFragmentEditor", () => {
	it("recognises an editor mounted inside another editor", () => {
		const host = new FakeElement(["cm-editor"]);
		const content = new FakeElement(["cm-content"]);
		const table = new FakeElement(["cm-embed-block", "cm-table-widget"]);
		const cell = new FakeElement(["table-cell-wrapper"]);
		const fragment = new FakeElement(["cm-editor"]);
		host.append(content);
		content.append(table);
		table.append(cell);
		cell.append(fragment);
		expect(isFragmentEditor(fragment)).toBe(true);
		expect(isFragmentEditor(host)).toBe(false);
	});

	it("does not mistake an unattached editor for a host", () => {
		expect(isFragmentEditor(new FakeElement(["cm-editor"]))).toBe(false);
	});
});

describe("editorSelectionTrust", () => {
	const doc = "Cut the tag once the fix lands.\n\n> Callout body\n";

	function view(
		content: DomElementLike,
		selection: DomSelectionLike | null,
		from: number,
		to: number,
	): TrustableEditorView {
		return {
			dom: { ownerDocument: { getSelection: () => selection } },
			contentDOM: content,
			state: {
				selection: { main: { from, to } },
				sliceDoc: (a, b) => doc.slice(a, b),
			},
		};
	}

	it("trusts the state selection when the document agrees", () => {
		const { content, prose } = livePreviewFixture();
		const from = doc.indexOf("once the fix");
		const trusted = view(content, selectionOver(prose, prose, "once the fix"), from, from + 12);
		expect(editorSelectionTrust(trusted)).toBe("agrees");
		expect(isEditorSelectionTrusted(trusted)).toBe(true);
	});

	it("distrusts a stale state selection while the document selection is in a callout", () => {
		const { content, calloutText } = livePreviewFixture();
		const from = doc.indexOf("once the fix");
		const stale = view(content, selectionOver(calloutText, calloutText, "Callout body"), from, from + 12);
		expect(editorSelectionTrust(stale)).toBe("uneditable-widget");
		expect(isEditorSelectionTrusted(stale)).toBe(false);
	});

	it("distrusts a widget selection even when the state selection is empty", () => {
		const { content, calloutText } = livePreviewFixture();
		const empty = view(content, selectionOver(calloutText, calloutText, "Callout body"), 0, 0);
		expect(isEditorSelectionTrusted(empty)).toBe(false);
	});

	it("keeps trusting the state selection while the document selection is in the sidebar", () => {
		const { content, comment } = livePreviewFixture();
		const from = doc.indexOf("once the fix");
		const blurred = view(content, selectionOver(comment, comment, "a sidebar comment"), from, from + 12);
		expect(editorSelectionTrust(blurred)).toBe("outside-editor");
		expect(isEditorSelectionTrusted(blurred)).toBe(true);
	});
});
