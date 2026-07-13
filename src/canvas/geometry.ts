/**
 * Pure screen-space geometry for canvas pins and thread cards. No DOM:
 * pins.ts feeds it measured pane sizes and positions, unit tests feed
 * it numbers.
 */

/** Rendered pin box size in screen pixels (styles.css width/height). */
export const PIN_SIZE = 28;
/** Screen-pixel gap between stacked same-anchor pins (pin height + 6). */
export const PIN_STACK_GAP = 34;
/** Screen-pixel gap from a pin's anchor to its card's near edge. */
export const CARD_GAP = 38;
/** Gap between a flipped card's right edge and its pin, in screen px. */
export const CARD_FLIP_GAP = 32;
/** The card's designed width; shrinks on panes narrower than it. */
export const CARD_WIDTH = 320;
/** Minimum gap kept between screen-space UI and the pane edge. */
export const PIN_EDGE_MARGIN = 4;
/** How far past an edge a pin still gets nudged back on-screen. */
export const PIN_NUDGE_BAND = PIN_SIZE;
/** Minimum gap kept between the card and the pane edge. */
export const CARD_EDGE_MARGIN = 12;

/** The card's rendered width on a pane: designed width, shrinking to
    fit narrow (phone-width) panes. */
export function cardWidthFor(paneWidth: number): number {
	return Math.min(CARD_WIDTH, paneWidth - 2 * CARD_EDGE_MARGIN);
}

/** Clamp value into [min, max], but only when it's within the nudge
    band — anything further out is scrolled-away content, not edge
    clipping, and should keep tracking its anchor off-screen. */
export function nudgeIntoRange(
	value: number,
	min: number,
	max: number,
): number {
	if (max < min) return value;
	if (value > max && value <= max + PIN_NUDGE_BAND) return max;
	if (value < min && value >= min - PIN_NUDGE_BAND) return min;
	return value;
}

/** Whether a pin placed at (left, top) is close enough to the visible
    pane that its card should be clamped on-screen. Pins tracking
    scrolled-away anchors sit outside this band, and their card follows
    them off-screen instead of floating detached at a pane edge. */
export function pinNearPane(
	left: number,
	top: number,
	paneWidth: number,
	paneHeight: number,
): boolean {
	return (
		left >= -PIN_SIZE - PIN_NUDGE_BAND &&
		left <= paneWidth + PIN_NUDGE_BAND &&
		top >= -PIN_SIZE - PIN_NUDGE_BAND &&
		top <= paneHeight + PIN_NUDGE_BAND
	);
}
