import { describe, expect, it } from "@jest/globals";
import {
	commentFootnoteOrdinals,
	isCommentOnlySection,
	renderedElementSourceRange,
} from "src/preview/sections";

const SOURCE = [
	"# Review",
	"",
	"Anchor{>>Example:",
	"```ts",
	"const answer = 42;",
	"",
	"console.log(answer);",
	"```",
	"<<}",
	"",
	"Visible after.",
].join("\n");

describe("isCommentOnlySection", () => {
	it("matches a fenced block inside a multiline comment", () => {
		expect(
			isCommentOnlySection({ text: SOURCE, lineStart: 3, lineEnd: 7 }),
		).toBe(true);
	});

	it("matches the section containing only the closing delimiter", () => {
		expect(
			isCommentOnlySection({ text: SOURCE, lineStart: 8, lineEnd: 8 }),
		).toBe(true);
	});

	it("keeps the opening section that contains the visible anchor", () => {
		expect(
			isCommentOnlySection({ text: SOURCE, lineStart: 2, lineEnd: 2 }),
		).toBe(false);
	});

	it("keeps the section after the comment", () => {
		expect(
			isCommentOnlySection({ text: SOURCE, lineStart: 10, lineEnd: 10 }),
		).toBe(false);
	});

	it("handles metadata comments", () => {
		const source = [
			"Anchor{{author=\"relay-user\">>Example:",
			"```js",
			"run();",
			"```",
			"<<}}",
		].join("\n");
		expect(
			isCommentOnlySection({ text: source, lineStart: 1, lineEnd: 3 }),
		).toBe(true);
	});
});

describe("renderedElementSourceRange", () => {
	it("narrows a callout section to the matching list item", () => {
		const source = [
			"> [!question] Open questions",
			"> 1. First barrier",
			"> 2. {==Dispatch limit==}{{author=\"reviewer\">>Comment paragraph.",
			"",
			"More comment text.<<}}",
		].join("\n");
		const range = renderedElementSourceRange(
			{ text: source, lineStart: 0, lineEnd: 2 },
			"LI",
			"{Dispatch limit}{{author=reviewer>>Comment paragraph.",
		);

		expect(source.slice(range?.from, range?.to)).toBe(
			'{==Dispatch limit==}{{author="reviewer">>Comment paragraph.',
		);
	});

	it("keeps an ordinary paragraph's complete section range", () => {
		const source = "Before\nMultiline paragraph\nAfter";
		const range = renderedElementSourceRange(
			{ text: source, lineStart: 1, lineEnd: 1 },
			"P",
			"Multiline paragraph",
		);

		expect(source.slice(range?.from, range?.to)).toBe("Multiline paragraph");
	});
});

describe("commentFootnoteOrdinals", () => {
	it("finds footnotes referenced and defined inside comments", () => {
		const source = [
			"Outside[^outside] Anchor{>>Inside[^inside]",
			"",
			"[^inside]: Comment footnote<<}",
			"",
			"[^outside]: Document footnote",
		].join("\n");
		expect(Array.from(commentFootnoteOrdinals(source))).toEqual([2]);
	});

	it("does not classify footnotes in rendered comment bodies", () => {
		const body = "Reference[^inside]\n\n[^inside]: Comment footnote";
		expect(commentFootnoteOrdinals(body).size).toBe(0);
	});
});

import { tableCellRange } from "src/preview/sections";

describe("tableCellRange", () => {
	const row = "| relay | {==table cell==}{>>cell comment<<} here | done |";

	it("narrows to the requested column, trimmed of padding", () => {
		const cell = tableCellRange(row, 1);
		expect(row.slice(cell?.from, cell?.to)).toBe(
			"{==table cell==}{>>cell comment<<} here",
		);
		const first = tableCellRange(row, 0);
		expect(row.slice(first?.from, first?.to)).toBe("relay");
		const last = tableCellRange(row, 2);
		expect(row.slice(last?.from, last?.to)).toBe("done");
	});

	it("ignores the outer pipes and handles rows without them", () => {
		expect(tableCellRange(row, 3)).toBeNull();
		const bare = "a | b";
		const second = tableCellRange(bare, 1);
		expect(bare.slice(second?.from, second?.to)).toBe("b");
		const open = "| a | b";
		const openSecond = tableCellRange(open, 1);
		expect(open.slice(openSecond?.from, openSecond?.to)).toBe("b");
	});

	it("keeps an empty cell in its column", () => {
		const sparse = "| a |  | c |";
		const empty = tableCellRange(sparse, 1);
		expect(empty).not.toBeNull();
		expect(sparse.slice(empty?.from, empty?.to)).toBe("");
		const third = tableCellRange(sparse, 2);
		expect(sparse.slice(third?.from, third?.to)).toBe("c");
	});

	it("does not split on escaped pipes", () => {
		const escaped = "| a \\| b | c |";
		const first = tableCellRange(escaped, 0);
		expect(escaped.slice(first?.from, first?.to)).toBe("a \\| b");
	});
});

describe("renderedElementSourceRange for rendered blocks", () => {
	it("narrows a table cell to its column within the matching row", () => {
		const source = [
			"| Package | Notes |",
			"| --- | --- |",
			"| relay | {==table cell==}{>>cell comment<<} here |",
			"| other | plain |",
		].join("\n");
		const range = renderedElementSourceRange(
			{ text: source, lineStart: 0, lineEnd: 3 },
			"TD",
			"{table cell} here",
			{ cellIndex: 1 },
		);
		expect(source.slice(range?.from, range?.to)).toBe(
			"{==table cell==}{>>cell comment<<} here",
		);
	});

	it("strips the quote prefix from a callout paragraph", () => {
		const source = "> Ship {==callout text==}{>>callout comment<<} today.";
		const range = renderedElementSourceRange(
			{ text: source, lineStart: 0, lineEnd: 0 },
			"P",
			"Ship {callout text} today.",
		);
		expect(source.slice(range?.from, range?.to)).toBe(
			"Ship {==callout text==}{>>callout comment<<} today.",
		);
	});

	it("strips nested quote prefixes and heading markers", () => {
		const source = "> > ## Title {>>note<<}";
		const range = renderedElementSourceRange(
			{ text: source, lineStart: 0, lineEnd: 0 },
			"H2",
			"Title {>>note<<}",
		);
		expect(source.slice(range?.from, range?.to)).toBe("Title {>>note<<}");
	});

	it("narrows a table cell inside a callout", () => {
		const source = [
			"> [!note] Table",
			"> | Package | {==Version==}{>>which one?<<} |",
			"> | --- | --- |",
			"> | relay | 1.8.26 |",
		].join("\n");
		const range = renderedElementSourceRange(
			{ text: source, lineStart: 0, lineEnd: 3 },
			"TH",
			"{Version}",
			{ cellIndex: 1 },
		);
		expect(source.slice(range?.from, range?.to)).toBe(
			"{==Version==}{>>which one?<<}",
		);
	});

	it("keeps a multi-line paragraph's full range", () => {
		const source = "First line\nsecond line";
		const range = renderedElementSourceRange(
			{ text: source, lineStart: 0, lineEnd: 1 },
			"P",
			"First line second line",
		);
		expect(source.slice(range?.from, range?.to)).toBe(source);
	});
});
