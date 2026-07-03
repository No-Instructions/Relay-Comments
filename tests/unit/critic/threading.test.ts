import { describe, expect, it } from "@jest/globals";
import { parseCriticMarkup } from "src/critic/parse";
import {
	collectAttachedComments,
	isCriticSectionSeparator,
} from "src/critic/threading";

describe("isCriticSectionSeparator", () => {
	it("allows adjacency and a single blank-free line break", () => {
		expect(isCriticSectionSeparator("", 0, 0)).toBe(true);
		expect(isCriticSectionSeparator(" \n\t", 0, 3)).toBe(true);
		expect(isCriticSectionSeparator(" text ", 0, 6)).toBe(false);
		expect(isCriticSectionSeparator("", 2, 1)).toBe(false);
	});
});

describe("collectAttachedComments", () => {
	it("collects adjacent comment thread messages after an anchor", () => {
		const text = "{==subject==}{>>first<<}{>>second<<}";
		const marks = parseCriticMarkup(text);

		const attached = collectAttachedComments(marks, text, 0);

		expect(attached.comments.map((mark) => mark.content)).toEqual([
			"first",
			"second",
		]);
		expect(attached.separatorRanges).toEqual([]);
	});

	it("records legacy newline separators between anchor and comment", () => {
		const text = "{==subject==}\n{>>first<<}";
		const marks = parseCriticMarkup(text);

		const attached = collectAttachedComments(marks, text, 0);

		expect(attached.comments.map((mark) => mark.content)).toEqual(["first"]);
		expect(attached.separatorRanges).toEqual([[13, 14]]);
	});

	it("does not attach comments through intervening prose", () => {
		const text = "{==subject==} prose {>>first<<}";
		const marks = parseCriticMarkup(text);

		expect(collectAttachedComments(marks, text, 0).comments).toHaveLength(0);
	});

	it("can treat a comment as a thread anchor when requested", () => {
		const text = "{>>root<<}{>>reply<<}";
		const marks = parseCriticMarkup(text);

		expect(collectAttachedComments(marks, text, 0).comments).toHaveLength(0);
		expect(
			collectAttachedComments(marks, text, 0, undefined, {
				allowCommentAnchor: true,
			}).comments.map((mark) => mark.content),
		).toEqual(["reply"]);
	});
});
