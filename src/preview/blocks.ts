/**
 * Repairs for CriticMarkup that Obsidian's renderer has already mangled, and the
 * matching that lets highlights inside rendered blocks act as thread anchors.
 */
import type { CriticMark } from "../critic/types";
import {
	buildReviewRuns,
	reviewAnchorFrom,
	reviewAnchorTo,
	type ReviewRun,
} from "../critic/review-runs";
import { findPrecedingWordRange } from "../critic/display";
import {
	highlightPresentation,
	parseNativeHighlights,
} from "../markdown/highlights";

const TEXT_NODE = 3;

/** The slice of the DOM these helpers touch. */
export interface RepairableNode {
	nodeType: number;
	nodeValue: string | null;
	textContent: string | null;
	previousSibling: RepairableNode | null;
	nextSibling: RepairableNode | null;
	remove(): void;
}

export interface RepairableElement extends RepairableNode {
	tagName: string;
	querySelectorAll(selector: string): ArrayLike<RepairableElement>;
}

const MANGLED_SELECTOR =
	"mark:not(.critic-preview-highlight), del:not(.critic-preview-deletion)";

/**
 * Turn `{<mark>text</mark>}` back into `{==text==}` and `{<del>old~>new</del>}` into
 * `{~~old~>new~~}` where the braces sit in the adjacent text nodes. Returns the count.
 */
export function repairMangledMarks(root: RepairableElement): number {
	let repaired = 0;
	for (const el of Array.from(root.querySelectorAll(MANGLED_SELECTOR))) {
		const before = el.previousSibling;
		const after = el.nextSibling;
		if (
			!before ||
			!after ||
			before.nodeType !== TEXT_NODE ||
			after.nodeType !== TEXT_NODE
		) {
			continue;
		}
		const beforeText = before.nodeValue ?? "";
		const afterText = after.nodeValue ?? "";
		if (!beforeText.endsWith("{") || !afterText.startsWith("}")) continue;
		const inner = el.textContent ?? "";
		const raw =
			el.tagName.toUpperCase() === "DEL" ? `{~~${inner}~~}` : `{==${inner}==}`;
		before.nodeValue = beforeText.slice(0, -1) + raw + afterText.slice(1);
		el.remove();
		after.remove();
		repaired += 1;
	}
	return repaired;
}

/** Whether every mark sits whole in one text node, so the text pass can render it in place. */
export function marksIntact(
	textNodes: readonly string[],
	marks: readonly CriticMark[],
): boolean {
	return marks.every(
		(mark) =>
			mark.raw.includes("\n") === false &&
			textNodes.some((value) => value.includes(mark.raw)),
	);
}

export interface RenderedAnchorMatch {
	from: number;
	to: number;
}

/**
 * The review run a rendered highlight stands for, by its text and, for a word-anchored
 * comment, its title. Returns the run anchor's range, which threads are keyed by.
 */
export function matchRenderedAnchor(
	text: string,
	runs: readonly ReviewRun[],
	marks: readonly CriticMark[],
	shown: string,
	title: string | null,
): RenderedAnchorMatch | null {
	const wanted = shown.trim();
	if (!wanted) return null;
	const candidates = runs.filter((run) => {
		if (run.comments.length === 0) return false;
		if (anchorDisplayText(text, run, marks) !== wanted) return false;
		if (title === null) return true;
		return run.comments[0].content.trim() === title.trim();
	});
	if (candidates.length !== 1) return null;
	const [run] = candidates;
	return { from: reviewAnchorFrom(run.anchor), to: reviewAnchorTo(run.anchor) };
}

function anchorDisplayText(
	text: string,
	run: ReviewRun,
	marks: readonly CriticMark[],
): string {
	const anchor = run.anchor;
	if (anchor.kind === "native-highlight") return anchor.highlight.text.trim();
	const mark = anchor.mark;
	if (mark.type === "highlight") {
		const presentation = highlightPresentation(mark.content);
		return text
			.slice(mark.contentFrom + presentation.prefixLength, mark.contentTo)
			.trim();
	}
	if (mark.type === "comment") {
		const word = findPrecedingWordRange(text, mark.from, [...marks]);
		return word ? text.slice(word[0], word[1]).trim() : "";
	}
	return mark.content.trim();
}

/** Review runs with comments that touch a slice of the note. */
export function runsTouching(
	text: string,
	marks: readonly CriticMark[],
	from: number,
	to: number,
): ReviewRun[] {
	const nativeHighlights = parseNativeHighlights(text, [...marks]);
	return buildReviewRuns(text, [...marks], nativeHighlights).filter(
		(run) => run.comments.length > 0 && run.from < to && run.to > from,
	);
}
