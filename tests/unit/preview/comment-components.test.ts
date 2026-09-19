import { describe, expect, it } from "@jest/globals";
import { previewCommentComponents } from "src/preview/comment-components";

describe("preview comment components", () => {
	it("describes every comment in a highlighted thread", () => {
		const source =
			'==Anchor=={{authorId="user-1" author="Bongo Cat">>First **reply**<<}}' +
			'{{author="Second Reviewer" resolved="true">>Second reply<<}}';

		expect(previewCommentComponents(source)).toEqual([
			expect.objectContaining({
				body: "First **reply**",
				author: "user-1",
				status: "open",
			}),
			expect.objectContaining({
				body: "Second reply",
				author: "Second Reviewer",
				status: "resolved",
			}),
		]);
		const [first, second] = previewCommentComponents(source);
		expect(first.thread).toBe(second.thread);
		expect(first.key).not.toBe(second.key);
	});

	it("keeps standalone comments discoverable and skips empty comments", () => {
		expect(previewCommentComponents("Before {>>Standalone<<} after")).toEqual([
			expect.objectContaining({ body: "Standalone", author: null }),
		]);
		expect(previewCommentComponents("Before {>>   <<} after")).toEqual([]);
	});

	it("assigns a multiline thread to the section containing its anchor", () => {
		const source = [
			"Before",
			"{==Anchor==}",
			'{{author="Bongo Cat">>First line',
			"",
			"- second line<<}}",
			"After",
		].join("\n");
		const anchorFrom = source.indexOf("{==Anchor==}");
		const firstLine = source.indexOf("Before");
		const secondLine = source.indexOf("{==Anchor==}");

		expect(
			previewCommentComponents(source, {
				from: firstLine,
				to: secondLine - 1,
			}),
		).toEqual([]);
		expect(
			previewCommentComponents(source, {
				from: anchorFrom,
				to: source.indexOf("\n", anchorFrom),
			}),
		).toEqual([
			expect.objectContaining({
				body: "First line\n\n- second line",
				author: "Bongo Cat",
			}),
		]);
	});
});
