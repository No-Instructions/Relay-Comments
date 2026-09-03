import type { CriticMark } from "./types";

// New threads are written adjacent to their anchor ({==text==}{>>comment<<});
// legacy content separated by a single newline still parses as one thread.
export const CRITIC_SECTION_SEPARATOR = "";

export interface AttachedComments {
	comments: CriticMark[];
	separatorRanges: Array<[number, number]>;
}

export function collectAttachedComments(
	marks: CriticMark[],
	text: string,
	anchorIndex: number,
	consumed?: Set<string>,
	options: { allowCommentAnchor?: boolean } = {},
): AttachedComments {
	const anchor = marks[anchorIndex];
	if (
		!anchor?.valid ||
		(anchor.type === "comment" && !options.allowCommentAnchor)
	) {
		return { comments: [], separatorRanges: [] };
	}
	return collectAttachedCommentsAfter(marks, text, anchor.to, consumed);
}

export function collectAttachedCommentsAfter(
	marks: readonly CriticMark[],
	text: string,
	anchorTo: number,
	consumed?: ReadonlySet<string>,
): AttachedComments {
	const comments: CriticMark[] = [];
	const separatorRanges: Array<[number, number]> = [];
	let nextFrom = anchorTo;
	let low = 0;
	let high = marks.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (marks[middle].from < anchorTo) low = middle + 1;
		else high = middle;
	}

	for (let index = low; index < marks.length; index += 1) {
		const candidate = marks[index];
		if (
			!candidate.valid ||
			consumed?.has(candidate.id) ||
			candidate.type !== "comment" ||
			!isCriticSectionSeparator(text, nextFrom, candidate.from)
		) {
			break;
		}

		if (candidate.from > nextFrom) {
			separatorRanges.push([nextFrom, candidate.from]);
		}
		comments.push(candidate);
		nextFrom = candidate.to;
	}

	return { comments, separatorRanges };
}

export function isCriticSectionSeparator(
	text: string,
	from: number,
	to: number,
): boolean {
	if (from === to) return true;
	if (from > to) return false;
	return /^[\t ]*\r?\n[\t ]*$/.test(text.slice(from, to));
}
