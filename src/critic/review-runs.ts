import type { NativeHighlight } from "../markdown/highlights";
import {
	collectAttachedCommentsAfter,
	type AttachedComments,
} from "./threading";
import type { CriticMark, CriticMarkType } from "./types";

export type ReviewAnchor =
	| { kind: "critic"; mark: CriticMark }
	| { kind: "native-highlight"; highlight: NativeHighlight };

export interface ReviewRun {
	anchor: ReviewAnchor;
	comments: CriticMark[];
	separatorRanges: Array<[number, number]>;
	from: number;
	to: number;
}

/** Build one document-ordered model shared by every review surface. */
export function buildReviewRuns(
	text: string,
	marks: readonly CriticMark[],
	nativeHighlights: readonly NativeHighlight[],
): ReviewRun[] {
	const validMarks = marks
		.filter((mark) => mark.valid)
		.slice()
		.sort((left, right) => left.from - right.from || left.to - right.to);
	const anchors: ReviewAnchor[] = [
		...validMarks.map((mark): ReviewAnchor => ({ kind: "critic", mark })),
		...nativeHighlights.map(
			(highlight): ReviewAnchor => ({ kind: "native-highlight", highlight }),
		),
	].sort(
		(left, right) =>
			reviewAnchorFrom(left) - reviewAnchorFrom(right) ||
			reviewAnchorTo(left) - reviewAnchorTo(right),
	);
	const consumedComments = new Set<string>();
	const runs: ReviewRun[] = [];

	for (const anchor of anchors) {
		if (
			anchor.kind === "critic" &&
			consumedComments.has(anchor.mark.id)
		) {
			continue;
		}
		const attached: AttachedComments = collectAttachedCommentsAfter(
			validMarks,
			text,
			reviewAnchorTo(anchor),
			consumedComments,
		);
		if (anchor.kind === "critic") consumedComments.add(anchor.mark.id);
		for (const comment of attached.comments) {
			consumedComments.add(comment.id);
		}
		const comments =
			anchor.kind === "critic" && anchor.mark.type === "comment"
				? [anchor.mark, ...attached.comments]
				: attached.comments;
		const last = comments[comments.length - 1];
		runs.push({
			anchor,
			comments,
			separatorRanges: attached.separatorRanges,
			from: reviewAnchorFrom(anchor),
			to: Math.max(reviewAnchorTo(anchor), last?.to ?? 0),
		});
	}

	return runs;
}

export function reviewAnchorId(anchor: ReviewAnchor): string {
	return anchor.kind === "critic" ? anchor.mark.id : anchor.highlight.id;
}

export function reviewAnchorType(anchor: ReviewAnchor): CriticMarkType {
	return anchor.kind === "critic" ? anchor.mark.type : "highlight";
}

export function reviewAnchorFrom(anchor: ReviewAnchor): number {
	return anchor.kind === "critic" ? anchor.mark.from : anchor.highlight.from;
}

export function reviewAnchorTo(anchor: ReviewAnchor): number {
	return anchor.kind === "critic" ? anchor.mark.to : anchor.highlight.to;
}

export function reviewAnchorRaw(anchor: ReviewAnchor): string {
	return anchor.kind === "critic" ? anchor.mark.raw : anchor.highlight.raw;
}

export function reviewAnchorText(anchor: ReviewAnchor): string {
	return anchor.kind === "critic" ? anchor.mark.content : anchor.highlight.text;
}

export function reviewAnchorLine(anchor: ReviewAnchor): number {
	return anchor.kind === "critic" ? anchor.mark.line : anchor.highlight.line;
}

export function reviewAnchorContentFrom(anchor: ReviewAnchor): number {
	return anchor.kind === "critic"
		? anchor.mark.contentFrom
		: anchor.highlight.contentFrom;
}

export function reviewAnchorContentTo(anchor: ReviewAnchor): number {
	return anchor.kind === "critic"
		? anchor.mark.contentTo
		: anchor.highlight.contentTo;
}
