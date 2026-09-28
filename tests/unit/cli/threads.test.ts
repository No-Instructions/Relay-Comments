import { describe, expect, it } from "@jest/globals";
import {
	applyChanges,
	checkAnchorRange,
	findThread,
	locateQuote,
	planResolve,
	planSuggestionAction,
	projectThreads,
} from "src/cli/threads";
import { CliError } from "src/cli/types";

const NOTE = [
	"# Title",
	"",
	'{==the passage==}{{authorId="u1" author="Bongo Cat" date="2026-07-13T07:01:55.123Z">>Can we ground this sooner?<<}}{{author="Claude">>Yes, see below.<<}}',
	"Plain {~~old~>new~~}{>>because<<} text.",
	"==🔵native=={>>on native<<}",
	"",
	"{>>standalone<<}",
	"{++added++}",
	'{==done==}{{author="A" resolved="true">>closed<<}}',
	"{++unclosed",
].join("\n");

describe("projectThreads", () => {
	it("numbers threads in document order with 1-based lines", () => {
		const { threads, invalid } = projectThreads(NOTE);
		expect(threads.map((thread) => [thread.index, thread.kind, thread.line])).toEqual([
			[1, "highlight", 3],
			[2, "substitution", 4],
			[3, "native-highlight", 5],
			[4, "comment", 7],
			[5, "addition", 8],
			[6, "highlight", 9],
		]);
		expect(invalid).toEqual([
			{ line: 10, error: "Unclosed CriticMarkup mark.", raw: "{++unclosed" },
		]);
	});

	it("carries the anchor text, comments, and metadata", () => {
		const [highlight, substitution, native, standalone, addition, done] =
			projectThreads(NOTE).threads;
		expect(highlight.text).toBe("the passage");
		expect(highlight.comments).toEqual([
			expect.objectContaining({
				author: "Bongo Cat",
				authorId: "u1",
				date: "2026-07-13T07:01:55.123Z",
				text: "Can we ground this sooner?",
				line: 3,
			}),
			expect.objectContaining({ author: "Claude", text: "Yes, see below." }),
		]);
		expect(substitution).toMatchObject({ oldText: "old", newText: "new" });
		expect(substitution.comments.map((comment) => comment.text)).toEqual(["because"]);
		expect(native).toMatchObject({ text: "native", color: "blue" });
		expect(native.comments.map((comment) => comment.text)).toEqual(["on native"]);
		expect(standalone.text).toBe("");
		expect(standalone.comments.map((comment) => comment.text)).toEqual(["standalone"]);
		expect(addition.text).toBe("added");
		expect(done.resolved).toBe(true);
		expect(highlight.resolved).toBe(false);
	});

	it("spans the run from the anchor to the last attached comment", () => {
		const [highlight] = projectThreads(NOTE).threads;
		expect(NOTE.slice(highlight.anchorFrom, highlight.anchorTo)).toBe("{==the passage==}");
		expect(NOTE.slice(highlight.from, highlight.to)).toMatch(/^\{==the passage==}.*Yes, see below\.<<}}$/);
	});
});

describe("findThread", () => {
	it("finds by index or anchor id and explains a miss", () => {
		const { threads } = projectThreads(NOTE);
		expect(findThread(threads, "2").kind).toBe("substitution");
		expect(findThread(threads, threads[3].id).kind).toBe("comment");
		expect(() => findThread(threads, "9")).toThrow(CliError);
		expect(() => findThread(threads, "9")).toThrow(/No thread 9; the note has 6 threads/);
	});
});

describe("locateQuote", () => {
	const text = "one two\nthree two\nfour";

	it("finds a unique quote", () => {
		expect(locateQuote(text, "three")).toEqual({ from: 8, to: 13 });
	});

	it("asks for a line when the quote repeats and honors it", () => {
		expect(() => locateQuote(text, "two")).toThrow(/occurs 2 times/);
		try {
			locateQuote(text, "two");
		} catch (error) {
			expect((error as CliError).extra).toEqual({ occurrences: [1, 2] });
		}
		expect(locateQuote(text, "two", 2)).toEqual({ from: 14, to: 17 });
	});

	it("rejects a missing quote and an empty one", () => {
		expect(() => locateQuote(text, "five")).toThrow(/does not occur/);
		expect(() => locateQuote(text, "two", 3)).toThrow(/does not occur on line 3/);
		expect(() => locateQuote(text, "")).toThrow(CliError);
	});
});

describe("checkAnchorRange", () => {
	it("refuses a range that touches an existing mark", () => {
		const text = "aa {==bb==} cc";
		expect(() => checkAnchorRange(text, 0, 5)).toThrow(/already contains/);
		expect(checkAnchorRange(text, 0, 2)).toBeNull();
	});

	it("returns an exactly quoted native highlight and refuses a partial one", () => {
		const text = "aa ==bb cc== dd";
		expect(checkAnchorRange(text, 5, 10)?.text).toBe("bb cc");
		expect(checkAnchorRange(text, 3, 12)?.text).toBe("bb cc");
		expect(() => checkAnchorRange(text, 5, 7)).toThrow(/entire highlighted passage/);
	});
});

describe("planResolve", () => {
	it("removes the comments and unwraps a CriticMarkup highlight", () => {
		const text = '{==🟢passage==}{{author="A">>q<<}}{>>r<<} tail';
		const [thread] = projectThreads(text).threads;
		expect(applyChanges(text, planResolve(text, thread))).toBe("passage tail");
	});

	it("keeps a native highlight and a suggestion, dropping only their comments", () => {
		const native = "==passage=={>>q<<} tail";
		expect(applyChanges(native, planResolve(native, projectThreads(native).threads[0]))).toBe(
			"==passage== tail",
		);
		const suggestion = "{++new++}{>>why<<} tail";
		expect(
			applyChanges(suggestion, planResolve(suggestion, projectThreads(suggestion).threads[0])),
		).toBe("{++new++} tail");
	});

	it("removes a standalone comment run entirely", () => {
		const text = "head {>>a<<}{>>b<<} tail";
		expect(applyChanges(text, planResolve(text, projectThreads(text).threads[0]))).toBe(
			"head  tail",
		);
	});

	it("refuses when there is nothing to resolve", () => {
		const native = "==passage== tail";
		expect(() => planResolve(native, projectThreads(native).threads[0])).toThrow(
			/no comments/,
		);
		const suggestion = "{--gone--} tail";
		expect(() => planResolve(suggestion, projectThreads(suggestion).threads[0])).toThrow(
			/accept or reject/,
		);
	});
});

describe("planSuggestionAction", () => {
	it("accepts and rejects a substitution with its comments", () => {
		const text = "a {~~old~>new~~}{>>why<<} b";
		const [thread] = projectThreads(text).threads;
		expect(applyChanges(text, planSuggestionAction(text, thread, "accept"))).toBe("a new b");
		expect(applyChanges(text, planSuggestionAction(text, thread, "reject"))).toBe("a old b");
	});

	it("refuses a thread that is not a suggestion", () => {
		const text = "{==h==}{>>c<<}";
		expect(() =>
			planSuggestionAction(text, projectThreads(text).threads[0], "accept"),
		).toThrow(/use comments:resolve/);
	});
});

describe("applyChanges", () => {
	it("applies changes given in any order against the original offsets", () => {
		expect(
			applyChanges("0123456789", [
				{ from: 1, to: 2, insert: "A" },
				{ from: 8, to: 8, insert: "Z" },
				{ from: 4, to: 6, insert: "" },
			]),
		).toBe("0A2367Z89");
	});
});
