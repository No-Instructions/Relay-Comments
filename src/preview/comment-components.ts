import { parseCriticMarkup } from "../critic/parse";
import { buildReviewRuns, reviewAnchorFrom } from "../critic/review-runs";
import { parseNativeHighlights } from "../markdown/highlights";

export interface PreviewCommentComponent {
	body: string;
	author: string | null;
	status: "open" | "resolved";
	thread: string;
	key: string;
}

export function previewCommentComponents(
	source: string,
	range: { from: number; to: number } = { from: 0, to: source.length },
): PreviewCommentComponent[] {
	const marks = parseCriticMarkup(source);
	return buildReviewRuns(source, marks, parseNativeHighlights(source, marks))
		.filter((run) => {
			const anchorFrom = reviewAnchorFrom(run.anchor);
			return anchorFrom >= range.from && anchorFrom <= range.to;
		})
		.flatMap((run) =>
			run.comments
				.filter((comment) => comment.valid && comment.content.trim().length > 0)
				.map((comment) => ({
					body: comment.content,
					author:
						comment.metadata?.authorId?.trim() ??
						comment.metadata?.author?.trim() ??
						null,
					status:
						comment.metadata?.resolved === "true"
							? ("resolved" as const)
							: ("open" as const),
					thread: `run:${run.from}:${run.to}`,
					key: comment.id,
				})),
		);
}
