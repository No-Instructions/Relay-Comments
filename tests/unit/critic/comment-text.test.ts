import { describe, expect, it } from "@jest/globals";
import { sanitizeCommentText } from "src/critic/comment-text";

describe("sanitizeCommentText", () => {
	it("preserves fenced code blocks, blank lines, and indentation", () => {
		const comment = [
			"Example:",
			"```ts",
			"if (ready) {",
			"  run();",
			"",
			"  finish();",
			"}",
			"```",
		].join("\r\n");

		expect(sanitizeCommentText(comment)).toBe(comment.replaceAll("\r\n", "\n"));
	});

	it("keeps the CriticMarkup closing delimiter inert inside a body", () => {
		expect(sanitizeCommentText("before <<} after")).toBe(
			"before << } after",
		);
	});
});
