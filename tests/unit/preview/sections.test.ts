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
