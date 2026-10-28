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

/** Match a rendered section in document order, including repeated passages.
 * Bare highlights participate in matching but do not open comment threads.
 * A mismatched count is ambiguous, so those elements remain unbound.
 */
export function matchRenderedSectionAnchors(
	text: string,
	marks: readonly CriticMark[],
	range: { from: number; to: number },
	shown: readonly string[],
): Array<RenderedAnchorMatch | null> {
	const runs = buildReviewRuns(text, [...marks], parseNativeHighlights(text, marks))
		.filter((run) => run.from < range.to && run.to > range.from)
		.filter((run) => run.anchor.kind === "native-highlight" ||
			run.anchor.mark.type === "highlight" || run.anchor.mark.type === "comment");
	const result: Array<RenderedAnchorMatch | null> = shown.map(() => null);
	for (const label of new Set(shown.map((value) => value.trim()))) {
		if (!label) continue;
		const candidates = runs.filter((run) => anchorDisplayText(text, run, marks) === label);
		const indices = shown.flatMap((value, index) => value.trim() === label ? [index] : []);
		if (candidates.length !== indices.length) continue;
		for (let index = 0; index < candidates.length; index += 1) {
			const run = candidates[index];
			if (run.comments.length === 0) continue;
			result[indices[index]] = {
				from: reviewAnchorFrom(run.anchor),
				to: reviewAnchorTo(run.anchor),
			};
		}
	}
	return result;
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

/** Whether a rendered element belongs to a comment body rather than a note.
    Comment bodies go through Obsidian's renderer too, and treating them as
    note content loops: the sidebar renders a body, the postprocessor reports
    rendered comments, the sidebar renders again. */
export function isCommentBodyRender(el: {
	closest(selector: string): unknown;
}): boolean {
	return el.closest(".critic-comment-markdown") != null;
}
