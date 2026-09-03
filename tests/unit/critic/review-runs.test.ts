import { describe, expect, it } from "@jest/globals";
import { parseCriticMarkup } from "src/critic/parse";
import { buildReviewRuns } from "src/critic/review-runs";
import { parseNativeHighlights } from "src/markdown/highlights";

function runsFor(text: string) {
	const marks = parseCriticMarkup(text);
	return buildReviewRuns(text, marks, parseNativeHighlights(text, marks));
}

describe("buildReviewRuns", () => {
	it("keeps native highlights distinct from CriticMarkup highlights", () => {
		const runs = runsFor("==🔵native== then {==🟢Critic==}");

		expect(runs).toHaveLength(2);
		expect(runs[0].anchor).toMatchObject({
			kind: "native-highlight",
			highlight: { text: "native", color: "blue" },
		});
		expect(runs[1].anchor).toMatchObject({
			kind: "critic",
			mark: { type: "highlight", content: "🟢Critic" },
		});
	});

	it("attaches an adjacent CriticMarkup comment thread to a native highlight", () => {
		const text =
			'==🔵passage=={{author="Bongo Cat">>First<<}}{>>Second<<}';
		const [run] = runsFor(text);

		expect(run.anchor.kind).toBe("native-highlight");
		expect(run.comments.map((comment) => comment.content)).toEqual([
			"First",
			"Second",
		]);
		expect(run.from).toBe(0);
		expect(run.to).toBe(text.length);
	});

	it("supports the legacy one-line separator before a native thread", () => {
		const text = "==passage==\n{>>Comment<<}";
		const [run] = runsFor(text);

		expect(run.comments.map((comment) => comment.content)).toEqual(["Comment"]);
		expect(run.separatorRanges).toEqual([[11, 12]]);
	});

	it("does not attach a comment through intervening prose", () => {
		const runs = runsFor("==passage== prose {>>Comment<<}");

		expect(runs).toHaveLength(2);
		expect(runs[0].comments).toEqual([]);
		expect(runs[1].anchor).toMatchObject({
			kind: "critic",
			mark: { type: "comment", content: "Comment" },
		});
	});

	it("does not emit attached comments as duplicate runs", () => {
		const runs = runsFor("==passage=={>>Comment<<}");

		expect(runs).toHaveLength(1);
		expect(runs[0].comments).toHaveLength(1);
	});
});
