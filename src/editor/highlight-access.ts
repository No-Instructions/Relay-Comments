import { Transaction } from "@codemirror/state";
import { parseCriticMarkup } from "../critic/parse";
import { buildReviewRuns } from "../critic/review-runs";
import { COLOR_EMOJIS, highlightPresentation, parseNativeHighlights } from "../markdown/highlights";
import { isEditorReadOnly } from "./access";

/** Obsidian's already-open swatch menu dispatches even after access is revoked. */
export function allowHighlightColorChange(transaction: Transaction): boolean {
	if (
		!transaction.docChanged ||
		!transaction.isUserEvent("input.type") ||
		transaction.annotation(Transaction.remote) ||
		!isEditorReadOnly({ state: transaction.startState })
	) return true;

	const source = transaction.startState.doc.toString();
	const marks = parseCriticMarkup(source);
	const ranges = buildReviewRuns(source, marks, parseNativeHighlights(source, marks)).flatMap(run => {
		if (run.anchor.kind === "native-highlight") {
			const highlight = run.anchor.highlight;
			return run.comments.length > 0
				? [[highlight.from + 2, highlight.from + 2 + (highlight.emoji?.length ?? 0)]]
				: [];
		}
		const mark = run.anchor.mark;
		if (mark.type !== "highlight") return [];
		const emoji = highlightPresentation(mark.content).emoji;
		return [[mark.contentFrom, mark.contentFrom + (emoji?.length ?? 0)]];
	});
	let allowed = true;
	transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
		const marker = inserted.toString();
		if (
			ranges.some(([start, end]) => from === start && to === end) &&
			(marker === "" || COLOR_EMOJIS.some(([emoji]) => marker === emoji))
		) allowed = false;
	});
	return allowed;
}
