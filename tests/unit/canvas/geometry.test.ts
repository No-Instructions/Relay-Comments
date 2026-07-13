import { describe, expect, it } from "@jest/globals";
import {
	CARD_EDGE_MARGIN,
	CARD_WIDTH,
	cardWidthFor,
	nudgeIntoRange,
	PIN_NUDGE_BAND,
	PIN_SIZE,
	pinNearPane,
} from "src/canvas/geometry";

describe("cardWidthFor", () => {
	it("keeps the designed width on panes that fit it", () => {
		expect(cardWidthFor(1200)).toBe(CARD_WIDTH);
		expect(cardWidthFor(CARD_WIDTH + 2 * CARD_EDGE_MARGIN)).toBe(CARD_WIDTH);
	});

	it("shrinks on panes narrower than the designed width plus margins", () => {
		expect(cardWidthFor(390)).toBe(CARD_WIDTH);
		expect(cardWidthFor(320)).toBe(320 - 2 * CARD_EDGE_MARGIN);
		expect(cardWidthFor(300)).toBe(300 - 2 * CARD_EDGE_MARGIN);
	});
});

describe("nudgeIntoRange", () => {
	const MIN = 4;
	const MAX = 358;

	it("leaves in-range values alone", () => {
		expect(nudgeIntoRange(100, MIN, MAX)).toBe(100);
		expect(nudgeIntoRange(MIN, MIN, MAX)).toBe(MIN);
		expect(nudgeIntoRange(MAX, MIN, MAX)).toBe(MAX);
	});

	it("nudges values just past an edge back to it", () => {
		expect(nudgeIntoRange(MAX + 1, MIN, MAX)).toBe(MAX);
		expect(nudgeIntoRange(MAX + PIN_NUDGE_BAND, MIN, MAX)).toBe(MAX);
		expect(nudgeIntoRange(MIN - 1, MIN, MAX)).toBe(MIN);
		expect(nudgeIntoRange(MIN - PIN_NUDGE_BAND, MIN, MAX)).toBe(MIN);
	});

	it("lets values beyond the band keep tracking off-screen anchors", () => {
		expect(nudgeIntoRange(MAX + PIN_NUDGE_BAND + 1, MIN, MAX)).toBe(
			MAX + PIN_NUDGE_BAND + 1,
		);
		expect(nudgeIntoRange(MIN - PIN_NUDGE_BAND - 1, MIN, MAX)).toBe(
			MIN - PIN_NUDGE_BAND - 1,
		);
	});

	it("returns the value untouched on an inverted range", () => {
		expect(nudgeIntoRange(50, 100, 10)).toBe(50);
	});
});

describe("pinNearPane", () => {
	const W = 390;
	const H = 733;

	it("accepts pins inside the pane", () => {
		expect(pinNearPane(10, 10, W, H)).toBe(true);
		expect(pinNearPane(W - PIN_SIZE, H - PIN_SIZE, W, H)).toBe(true);
	});

	it("accepts pins just past an edge (the nudge band)", () => {
		expect(pinNearPane(W + PIN_NUDGE_BAND, 100, W, H)).toBe(true);
		expect(pinNearPane(-PIN_SIZE - PIN_NUDGE_BAND, 100, W, H)).toBe(true);
	});

	it("rejects pins tracking scrolled-away anchors", () => {
		expect(pinNearPane(W + PIN_NUDGE_BAND + 1, 100, W, H)).toBe(false);
		expect(pinNearPane(100, H + PIN_NUDGE_BAND + 1, W, H)).toBe(false);
		expect(pinNearPane(-PIN_SIZE - PIN_NUDGE_BAND - 1, 100, W, H)).toBe(
			false,
		);
	});
});
