import { describe, expect, it } from "@jest/globals";
import { parseCriticMarkup } from "src/critic/parse";
import {
	findNativeHighlightAtOffset,
	findNativeHighlightForSelection,
	highlightColorClass,
	highlightPresentation,
	parseNativeHighlights,
} from "src/markdown/highlights";

describe("highlightPresentation", () => {
	it.each([
		["plain", "default", null, "plain", 0],
		["🔴red", "red", "🔴", "red", 2],
		["🟠 orange", "orange", "🟠", "orange", 3],
		["🟢green", "green", "🟢", "green", 2],
		["🔵blue", "blue", "🔵", "blue", 2],
		["🟣purple", "purple", "🟣", "purple", 2],
	] as const)(
		"reads %s as a %s highlight",
		(content, color, emoji, text, prefixLength) => {
			expect(highlightPresentation(content)).toEqual({
				color,
				emoji,
				text,
				prefixLength,
			});
		},
	);

	it("only removes one optional spacer after the color marker", () => {
		expect(highlightPresentation("🔵  indented").text).toBe(" indented");
	});

	it("maps every color to a stable CSS class", () => {
		expect(highlightColorClass("purple")).toBe(
			"critic-highlight-color-purple",
		);
	});
});

describe("parseNativeHighlights", () => {
	it("parses plain and colored highlights with exact source ranges", () => {
		const text = "Before ==plain== and ==🔵 blue phrase== after";
		const highlights = parseNativeHighlights(text, []);

		expect(
			highlights.map(({ raw, text: content, color, from, to, contentFrom, contentTo, line }) => ({
				raw,
				content,
				color,
				from,
				to,
				contentFrom,
				contentTo,
				line,
			})),
		).toEqual([
			{
				raw: "==plain==",
				content: "plain",
				color: "default",
				from: 7,
				to: 16,
				contentFrom: 9,
				contentTo: 14,
				line: 0,
			},
			{
				raw: "==🔵 blue phrase==",
				content: "blue phrase",
				color: "blue",
				from: 21,
				to: 39,
				contentFrom: 26,
				contentTo: 37,
				line: 0,
			},
		]);
	});

	it("keeps native syntax inside CriticMarkup out of the native list", () => {
		const text = [
			"{==🔴Critic highlight==}",
			"{>>Comment with ==🔵inline highlight==<<}",
			'{{author="Bongo Cat">>Metadata comment with ==🟢highlight==<<}}',
			"==🟣native==",
		].join("\n");
		const marks = parseCriticMarkup(text);

		expect(parseNativeHighlights(text, marks).map((item) => item.raw)).toEqual([
			"==🟣native==",
		]);
	});

	it("ignores code, escapes, triple delimiters, and empty highlights", () => {
		const text = [
			"`==inline==` and \\==escaped== and ===triple=== and == ==",
			"```md",
			"==fenced==",
			"```",
			"~~~",
			"==also fenced==",
			"~~~",
			"==visible==",
		].join("\n");

		expect(parseNativeHighlights(text, []).map((item) => item.raw)).toEqual([
			"==visible==",
		]);
	});

	it("tracks highlights on separate lines", () => {
		const text = "==one==\nordinary\n==🟢two==";
		expect(
			parseNativeHighlights(text, []).map((item) => [item.text, item.line]),
		).toEqual([
			["one", 0],
			["two", 2],
		]);
	});

	it("finds the displayed or raw selection and cursor target", () => {
		const text = "A ==🔴target== Z";
		const highlights = parseNativeHighlights(text, []);
		const [highlight] = highlights;

		expect(
			findNativeHighlightForSelection(
				highlights,
				highlight.contentFrom,
				highlight.contentTo,
			),
		).toBe(highlight);
		expect(
			findNativeHighlightForSelection(
				highlights,
				highlight.from,
				highlight.to,
			),
		).toBe(highlight);
		expect(findNativeHighlightAtOffset(highlights, highlight.contentFrom + 1)).toBe(
			highlight,
		);
		expect(findNativeHighlightForSelection(highlights, 0, 1)).toBeNull();
	});
});
