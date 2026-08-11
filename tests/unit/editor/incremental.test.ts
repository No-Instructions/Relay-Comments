import { describe, expect, it } from "@jest/globals";
import { canReuseCriticStateForTrailingChanges } from "src/editor/incremental";

describe("incremental CriticMarkup editor updates", () => {
	it("reuses state for plain text edits after the final mark", () => {
		expect(
			canReuseCriticStateForTrailingChanges(40, [
				{ from: 40, deleted: "", inserted: " more text" },
			]),
		).toBe(true);
	});

	it("reparses edits before or inside the final mark", () => {
		expect(
			canReuseCriticStateForTrailingChanges(40, [
				{ from: 39, deleted: "", inserted: "x" },
			]),
		).toBe(false);
	});

	it("reparses possible CriticMarkup delimiters", () => {
		expect(
			canReuseCriticStateForTrailingChanges(40, [
				{ from: 50, deleted: "", inserted: "{==new==}" },
			]),
		).toBe(false);
		expect(
			canReuseCriticStateForTrailingChanges(40, [
				{ from: 50, deleted: "}", inserted: "" },
			]),
		).toBe(false);
	});

	it("reuses empty state while ordinary text is typed", () => {
		expect(
			canReuseCriticStateForTrailingChanges(0, [
				{ from: 0, deleted: "", inserted: "ordinary text" },
			]),
		).toBe(true);
	});
});
