import { describe, expect, it } from "@jest/globals";
import {
	locateRenderedCalloutText,
	renderedCalloutSelection,
	type CalloutSection,
	type CalloutSelectionView,
} from "src/editor/rendered-callout";

/** Source slice for the `nth` rendered occurrence of `selected` in a section. */
function locate(
	source: string,
	section: CalloutSection,
	rendered: string,
	selected: string,
	nth = 0,
): string | null {
	let start = -1;
	for (let i = 0; i <= nth; i += 1) start = rendered.indexOf(selected, start + 1);
	if (start < 0) throw new Error("selection not in rendered text");
	const range = locateRenderedCalloutText(source, 0, section, rendered, start, selected);
	return range ? `${range.from}:${source.slice(range.from, range.to)}` : null;
}

const at = (source: string, text: string, from = 0): string => `${source.indexOf(text, from)}:${text}`;

describe("locateRenderedCalloutText", () => {
	const source = [
		"> [!note] Callout title words",
		"> First line with some words.",
		"> Second line with **bold** text and some words.",
		"",
		"After with some words.",
	].join("\n");
	const body = "First line with some words.\nSecond line with bold text and some words.";

	it("finds selected body text in the callout's source", () => {
		expect(locate(source, "body", body, "First line")).toBe(at(source, "First line"));
	});

	it("picks the occurrence the rendered selection points at", () => {
		expect(locate(source, "body", body, "some words", 1)).toBe(
			at(source, "some words", source.indexOf("Second")),
		);
	});

	it("keeps the exact position of overlapping occurrences", () => {
		const text = "> [!note] T\n> banana";
		expect(locateRenderedCalloutText(text, 0, "body", "banana", 3, "ana")).toEqual({ from: 17, to: 20 });
		expect(locateRenderedCalloutText(text, 0, "body", "banana", 1, "ana")).toEqual({ from: 15, to: 18 });
	});

	it("refuses a selection start that is not an occurrence", () => {
		expect(locateRenderedCalloutText(source, 0, "body", body, 2, "First")).toBeNull();
	});

	it("matches the title after the callout marker", () => {
		expect(locate(source, "title", "Callout title words", "title")).toBe(at(source, "title"));
	});

	it("spans emphasis that rendering hides", () => {
		expect(locate(source, "body", body, "with bold text")).toBe(at(source, "with **bold** text"));
	});

	it("never matches text outside the callout", () => {
		const text = "> [!note] T\n> words\n\nwords";
		expect(locate(text, "body", "words", "words")).toBe(at(text, "words"));
	});

	it("refuses empty, multi-line, or absent text", () => {
		expect(locateRenderedCalloutText(source, 0, "body", body, 0, "")).toBeNull();
		expect(locateRenderedCalloutText(source, 0, "body", body, 20, "words.\nSecond")).toBeNull();
		expect(locateRenderedCalloutText(source, 0, "body", "missing", 0, "missing")).toBeNull();
	});

	it("skips a link destination and anchors the visible word", () => {
		const text = "> [!tip] Custom\n> [site](https://example.com/alpha) alpha";
		expect(locate(text, "body", "site alpha", "alpha")).toBe(`${text.lastIndexOf("alpha")}:alpha`);
	});

	it("refuses a selection that spans a link destination", () => {
		const text = "> [!tip] Custom\n> [site](https://example.com/) alpha";
		expect(locate(text, "body", "site alpha", "site alpha")).toBeNull();
	});

	it("does not count a generated title as source text", () => {
		const text = "> [!note]\n> Note first. Note second.";
		expect(locate(text, "body", "Note first. Note second.", "Note")).toBe(`${text.indexOf("Note first")}:Note`);
		expect(locate(text, "title", "Note", "Note")).toBeNull();
	});

	it("refuses when an embed may render matching text", () => {
		const text = "> [!note] T\n> ![[alpha]] then alpha";
		expect(locate(text, "body", "alpha then alpha", "alpha", 1)).toBeNull();
	});

	it("refuses when unmodelled syntax and an embed cancel out", () => {
		const text = "> [!note] T\n> &copy; ![[Other]]";
		expect(locateRenderedCalloutText(text, 0, "body", "\u00a9 copy", 2, "copy")).toBeNull();
	});

	it("refuses a section whose rendered text includes content the source lacks", () => {
		const text = "> [!note] T\n> one ![[Other]] two";
		expect(locate(text, "body", "one embedded two", "two")).toBeNull();
	});

	it("ignores whitespace differences between source and rendered text", () => {
		const text = "> [!note] T\n> one   two\n> three";
		expect(locate(text, "body", "one two\nthree", "three")).toBe(at(text, "three"));
	});

	it("refuses a selection that crosses source lines", () => {
		const text = "> [!note] T\n> one\n> two";
		expect(locate(text, "body", "one two", "one two")).toBeNull();
	});

	it("maps escaped characters to their source", () => {
		const text = "> [!note] T\n> a \\*star\\* here";
		expect(locate(text, "body", "a *star* here", "*star*")).toBe(at(text, "*star\\*"));
	});

	it("skips existing comment bodies and highlight syntax", () => {
		const text = '> [!note] T\n> {==Alpha==}{{author="R">>beta<<}} then beta and Alpha';
		expect(locate(text, "body", "Alpha then beta and Alpha", "beta")).toBe(at(text, "beta", text.indexOf("then")));
		expect(locate(text, "body", "Alpha then beta and Alpha", "Alpha", 1)).toBe(at(text, "Alpha", text.indexOf("and")));
	});

	it.each([
		["a wikilink alias", "> [!note] T\n> see [[target|alias]] and alias", "see alias and alias"],
		["a link label", "> [!note] T\n> see [alias](https://example.com) and alias", "see alias and alias"],
		["a code span", "> [!note] T\n> see `alias` and alias", "see alias and alias"],
	])("refuses text inside %s but anchors the same text after it", (_, text, rendered) => {
		expect(locate(text, "body", rendered, "alias")).toBeNull();
		expect(locate(text, "body", rendered, "alias", 1)).toBe(`${text.lastIndexOf("alias")}:alias`);
	});
});

describe("renderedCalloutSelection", () => {
	function viewWithSelection(selected: string): CalloutSelectionView {
		const calloutBox = { tag: "callout" };
		const callout = {
			closest: () => null,
			querySelector: () => calloutBox,
			ownerDocument: { createRange: () => { throw new Error("must not measure an empty selection"); } },
		};
		const section = {
			closest: (selector: string) => (selector === ".callout" ? calloutBox : callout),
			matches: () => false,
			textContent: "First line",
		};
		const node = { nodeType: 3, parentElement: { closest: () => section } };
		const range = { startContainer: node, endContainer: node, startOffset: 0, endOffset: selected.length, toString: () => selected };
		const contentDOM = {
			contains: () => true,
			ownerDocument: { getSelection: () => ({ rangeCount: 1, getRangeAt: () => range }) },
		};
		return {
			contentDOM,
			state: { doc: { toString: () => "> [!note] T\n> First line", lineAt: () => ({ from: 0 }) } },
			posAtDOM: () => 0,
		} as unknown as CalloutSelectionView;
	}

	it.each(["", " ", "\n\t"])("refuses a collapsed or whitespace-only selection %j", (selected) => {
		expect(renderedCalloutSelection(viewWithSelection(selected))).toBeNull();
	});
});
