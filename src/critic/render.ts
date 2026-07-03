import { parseCriticMarkup } from "./parse";
import { collectAttachedComments } from "./threading";
import type { CriticMark, DisplayMode, RenderSegment } from "./types";

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
	const anchored = findAnchoredCommentMarkup(marks, text);
	const segments: RenderSegment[] = [];
	let cursor = from;

	for (const mark of marks) {
		if (mark.to <= cursor) continue;
		if (mark.from >= to) break;
		const markStart = Math.max(mark.from, from);
		if (markStart > cursor) {
			const separatorEnd = anchored.separatorEndByStart.get(cursor);
			if (separatorEnd !== mark.from) {
				segments.push({ kind: "text", text: text.slice(cursor, markStart) });
			}
		}
		if (mark.valid && anchored.commentIds.has(mark.id)) {
			// Anchored comment bodies belong in the review sidebar, not inline text.
		} else {
			segments.push(...clipMarkSegments(text, mark, mode, from, to));
		}
		cursor = Math.min(mark.to, to);
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

	if (mode === "clean") {
		switch (mark.type) {
			case "addition":
			case "highlight":
				return content ? [{ kind: "text", text: content }] : [];
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
			return content ? [{ kind: "highlight", text: content }] : [];
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

function findAnchoredCommentMarkup(
	marks: CriticMark[],
	text: string,
): {
	commentIds: Set<string>;
	separatorEndByStart: Map<number, number>;
} {
	const commentIds = new Set<string>();
	const separatorEndByStart = new Map<number, number>();
	for (let index = 0; index < marks.length; index += 1) {
		const mark = marks[index];
		if (!mark.valid || commentIds.has(mark.id)) continue;

		const attached = collectAttachedComments(marks, text, index, commentIds, {
			allowCommentAnchor: true,
		});
		for (const comment of attached.comments) {
			commentIds.add(comment.id);
		}
		for (const [from, to] of attached.separatorRanges) {
			separatorEndByStart.set(from, to);
		}
	}
	return { commentIds, separatorEndByStart };
}
