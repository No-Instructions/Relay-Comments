import { parseCriticMarkup } from "./parse";
import { buildReviewRuns } from "./review-runs";
import type { CriticMark, DisplayMode, RenderSegment } from "./types";
import {
	highlightPresentation,
	parseNativeHighlights,
	type NativeHighlight,
} from "../markdown/highlights";

export function renderDisplaySegments(
	text: string,
	mode: DisplayMode,
): RenderSegment[] {
	return renderSliceSegments(text, 0, text.length, mode);
}

/**
 * Render the [from, to) slice of a document. Marks that straddle the slice
 * boundaries (e.g. a highlight spanning two rendered sections) contribute
 * only their in-slice portion, with delimiters hidden.
 */
export function renderSliceSegments(
	text: string,
	from: number,
	to: number,
	mode: DisplayMode,
): RenderSegment[] {
	const marks = parseCriticMarkup(text);
	const nativeHighlights = parseNativeHighlights(text, marks);
	const runs = buildReviewRuns(text, marks, nativeHighlights);
	const anchored = findAnchoredCommentMarkup(runs);
	const entries: Array<
		| { kind: "critic"; from: number; to: number; mark: CriticMark }
		| { kind: "native"; from: number; to: number; highlight: NativeHighlight }
	> = [
		...marks.map((mark) => ({
			kind: "critic" as const,
			from: mark.from,
			to: mark.to,
			mark,
		})),
		...nativeHighlights.map((highlight) => ({
			kind: "native" as const,
			from: highlight.from,
			to: highlight.to,
			highlight,
		})),
	].sort((left, right) => left.from - right.from || left.to - right.to);
	const segments: RenderSegment[] = [];
	let cursor = from;

	for (const entry of entries) {
		if (entry.to <= cursor) continue;
		if (entry.from >= to) break;
		const entryStart = Math.max(entry.from, from);
		if (entryStart > cursor) {
			const separatorEnd = anchored.separatorEndByStart.get(cursor);
			if (separatorEnd !== entry.from) {
				segments.push({ kind: "text", text: text.slice(cursor, entryStart) });
			}
		}
		if (
			entry.kind === "critic" &&
			entry.mark.valid &&
			anchored.commentIds.has(entry.mark.id)
		) {
			// Anchored comment bodies belong in the review sidebar, not inline text.
		} else if (entry.kind === "critic") {
			segments.push(
				...clipMarkSegments(text, entry.mark, mode, from, to),
			);
		} else {
			segments.push(...clipNativeHighlight(entry.highlight, from, to));
		}
		cursor = Math.min(entry.to, to);
	}

	if (cursor < to) {
		segments.push({ kind: "text", text: text.slice(cursor, to) });
	}

	return anchorCommentSegments(segments);
}

/**
 * Comments never render as floating indicators or raw text: anchor each one
 * to the word that precedes it (shown as a highlighted span with the comment
 * as its tooltip) and drop empty or unanchorable comments entirely — the
 * review sidebar remains their home.
 */
function anchorCommentSegments(segments: RenderSegment[]): RenderSegment[] {
	const result: RenderSegment[] = [];
	for (const segment of segments) {
		if (segment.kind !== "comment") {
			result.push(segment);
			continue;
		}
		const title = segment.title?.trim();
		if (!title) continue;
		const previous = result[result.length - 1];
		if (previous?.kind === "text") {
			const match = /(\S+)([ \t]*)$/.exec(previous.text);
			if (match && match.index !== undefined && !match[1].includes("\n")) {
				const leading = previous.text.slice(0, match.index);
				if (leading.length > 0) {
					previous.text = leading;
				} else {
					result.pop();
				}
				result.push({ kind: "highlight", text: match[1], title });
				if (match[2]) {
					result.push({ kind: "text", text: match[2] });
				}
			}
		}
	}
	return result;
}

function clipMarkSegments(
	text: string,
	mark: CriticMark,
	mode: DisplayMode,
	from: number,
	to: number,
): RenderSegment[] {
	const clipRange = (range?: [number, number]): string => {
		if (!range) return "";
		const start = Math.max(range[0], from);
		const end = Math.min(range[1], to);
		return end > start ? text.slice(start, end) : "";
	};

	if (!mark.valid) {
		// Never hide invalid/incomplete markup: show the raw source so no
		// document text silently disappears.
		const raw = clipRange([mark.from, mark.to]);
		return raw ? [{ kind: "text", text: raw }] : [];
	}

	const content = clipRange([mark.contentFrom, mark.contentTo]);
	const highlight =
		mark.type === "highlight" ? highlightPresentation(mark.content) : null;
	const highlightContent = highlight
		? clipRange([
				mark.contentFrom + highlight.prefixLength,
				mark.contentTo,
			])
		: "";

	if (mode === "clean") {
		switch (mark.type) {
			case "addition":
				return content ? [{ kind: "text", text: content }] : [];
			case "highlight":
				return highlightContent
					? [{ kind: "text", text: highlightContent }]
					: [];
			case "deletion":
			case "comment":
				return [];
			case "substitution": {
				const newText = clipRange(mark.ranges.newText);
				return newText ? [{ kind: "text", text: newText }] : [];
			}
		}
	}

	switch (mark.type) {
		case "addition":
			return content ? [{ kind: "addition", text: content }] : [];
		case "deletion":
			return content ? [{ kind: "deletion", text: content }] : [];
		case "highlight":
			return highlightContent
				? [
						{
							kind: "highlight",
							text: highlightContent,
							...(highlight?.color !== "default"
								? { color: highlight?.color }
								: {}),
						},
					]
				: [];
		case "comment":
			// Indicator appears only where the comment starts.
			return mark.from >= from
				? [{ kind: "comment", text: "", title: mark.content }]
				: [];
		case "substitution": {
			const oldText = clipRange(mark.ranges.oldText);
			const newText = clipRange(mark.ranges.newText);
			const segments: RenderSegment[] = [];
			if (oldText) segments.push({ kind: "deletion", text: oldText });
			if (newText) segments.push({ kind: "addition", text: newText });
			return segments;
		}
	}
}

function clipNativeHighlight(
	highlight: NativeHighlight,
	from: number,
	to: number,
): RenderSegment[] {
	const start = Math.max(highlight.contentFrom, from);
	const end = Math.min(highlight.contentTo, to);
	if (end <= start) return [];
	const offset = start - highlight.contentFrom;
	return [
		{
			kind: "highlight",
			text: highlight.text.slice(offset, offset + (end - start)),
			...(highlight.color !== "default" ? { color: highlight.color } : {}),
		},
	];
}

function findAnchoredCommentMarkup(
	runs: ReturnType<typeof buildReviewRuns>,
): {
	commentIds: Set<string>;
	separatorEndByStart: Map<number, number>;
} {
	const commentIds = new Set<string>();
	const separatorEndByStart = new Map<number, number>();
	for (const run of runs) {
		const comments =
			run.anchor.kind === "critic" && run.anchor.mark.type === "comment"
				? run.comments.slice(1)
				: run.comments;
		for (const comment of comments) {
			commentIds.add(comment.id);
		}
		for (const [from, to] of run.separatorRanges) {
			separatorEndByStart.set(from, to);
		}
	}
	return { commentIds, separatorEndByStart };
}
