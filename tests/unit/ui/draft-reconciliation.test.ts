import { describe, expect, it } from "@jest/globals";
import {
	reconcileDraftTarget,
	type DraftTarget,
} from "src/ui/draft-reconciliation";

const target = (
	id: string,
	signature: string,
	from: number,
): DraftTarget => ({ id, signature, from });

describe("sidebar draft reconciliation", () => {
	it("keeps an exact item id when the document is unchanged", () => {
		const previous = target("thread:old", "highlight:key phrase", 20);
		expect(
			reconcileDraftTarget(previous, [
				target("thread:other", "highlight:other", 5),
				previous,
			]),
		).toEqual(previous);
	});

	it("follows the same thread when an incoming edit shifts its offsets", () => {
		const previous = target("thread:20:40", "highlight:key phrase", 20);
		const shifted = target("thread:37:57", "highlight:key phrase", 37);
		expect(reconcileDraftTarget(previous, [shifted])).toEqual(shifted);
	});

	it("uses the nearest matching anchor when content is duplicated", () => {
		const previous = target("thread:80:100", "highlight:same text", 80);
		const nearest = target("thread:85:105", "highlight:same text", 85);
		expect(
			reconcileDraftTarget(previous, [
				target("thread:10:30", "highlight:same text", 10),
				nearest,
			]),
		).toEqual(nearest);
	});

	it("does not move a draft onto a different thread", () => {
		const previous = target("thread:old", "highlight:key phrase", 20);
		expect(
			reconcileDraftTarget(previous, [
				target("thread:new", "highlight:different", 20),
			]),
		).toBeNull();
	});
});
