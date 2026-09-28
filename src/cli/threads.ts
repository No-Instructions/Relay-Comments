import { parseCriticMarkup } from "../critic/parse";
import {
	buildReviewRuns,
	reviewAnchorFrom,
	reviewAnchorTo,
	type ReviewRun,
} from "../critic/review-runs";
import { isSuggestionMark } from "../critic/display";
import { replacementForMark, type CriticAction } from "../critic/transform";
import type { CriticMark, CriticMarkType } from "../critic/types";
import {
	highlightPresentation,
	parseNativeHighlights,
	type HighlightColor,
	type NativeHighlight,
} from "../markdown/highlights";
import { CliError, type TextChange } from "./types";

/**
 * The thread model the CLI shows and acts on: one entry per review run in
 * document order, numbered so a caller can name a thread by index or by
 * the anchor's id. Pure functions over note text.
 */

/** A CriticMarkup anchor, a native highlight, or a canvas comment pin. */
export type ThreadKind = CriticMarkType | "native-highlight" | "pin";

export interface ThreadComment {
	author?: string;
	authorId?: string;
	date?: string;
	text: string;
	/** Source position; absent for comments on a canvas pin. */
	line?: number;
	from?: number;
	to?: number;
}

export interface ThreadInfo {
	/** 1-based position in the note's thread list. */
	index: number;
	/**
	 * The anchor mark's id, stable while the text before it is unchanged.
	 * On a canvas: `<node>:<mark id>` in a text card, or the pin's id.
	 */
	id: string;
	kind: ThreadKind;
	/** On a canvas: the node the thread belongs to. */
	node?: string;
	/** 1-based line of the anchor, within its card on a canvas. Absent for pins. */
	line?: number;
	/** The whole run: anchor plus attached comments. Within the card on a canvas. */
	from: number;
	to: number;
	anchorFrom: number;
	anchorTo: number;
	/** The passage, the addition or deletion text, or "" for a bare comment. */
	text: string;
	oldText?: string;
	newText?: string;
	color?: HighlightColor;
	resolved: boolean;
	comments: ThreadComment[];
}

export interface InvalidMark {
	/** On a canvas: the text card holding the mark. */
	node?: string;
	line: number;
	error: string;
	raw: string;
}

export interface NoteThreads {
	threads: ThreadInfo[];
	invalid: InvalidMark[];
}

function commentOf(mark: CriticMark): ThreadComment {
	const comment: ThreadComment = {
		text: mark.content,
		line: mark.line + 1,
		from: mark.from,
		to: mark.to,
	};
	if (mark.metadata?.author) comment.author = mark.metadata.author;
	if (mark.metadata?.authorId) comment.authorId = mark.metadata.authorId;
	if (mark.metadata?.date) comment.date = mark.metadata.date;
	return comment;
}

function threadOf(run: ReviewRun, index: number): ThreadInfo {
	const { anchor } = run;
	const comments = run.comments.map(commentOf);
	const resolved = [
		...(anchor.kind === "critic" ? [anchor.mark] : []),
		...run.comments,
	].some((mark) => mark.metadata?.resolved === "true");
	const base = {
		index,
		from: run.from,
		to: run.to,
		anchorFrom: reviewAnchorFrom(anchor),
		anchorTo: reviewAnchorTo(anchor),
		resolved,
		comments,
	};
	if (anchor.kind === "native-highlight") {
		const { highlight } = anchor;
		return {
			...base,
			id: highlight.id,
			kind: "native-highlight",
			line: highlight.line + 1,
			text: highlight.text,
			color: highlight.color,
		};
	}
	const { mark } = anchor;
	const thread: ThreadInfo = {
		...base,
		id: mark.id,
		kind: mark.type,
		line: mark.line + 1,
		text: "",
	};
	switch (mark.type) {
		case "highlight": {
			const presentation = highlightPresentation(mark.content);
			thread.text = presentation.text;
			thread.color = presentation.color;
			break;
		}
		case "substitution":
			thread.oldText = mark.oldText ?? "";
			thread.newText = mark.newText ?? "";
			break;
		case "comment":
			// The anchor is the first comment; the passage is whatever precedes it.
			break;
		default:
			thread.text = mark.content;
	}
	return thread;
}

export function projectThreads(text: string): NoteThreads {
	const marks = parseCriticMarkup(text);
	const runs = buildReviewRuns(text, marks, parseNativeHighlights(text, marks));
	return {
		threads: runs.map((run, i) => threadOf(run, i + 1)),
		invalid: marks
			.filter((mark) => !mark.valid)
			.map((mark) => ({
				line: mark.line + 1,
				error: mark.error ?? "Invalid CriticMarkup.",
				raw: mark.raw,
			})),
	};
}

/** A thread by 1-based index or anchor id. */
export function findThread(threads: ThreadInfo[], ref: string): ThreadInfo {
	const trimmed = ref.trim();
	const byId = threads.find((thread) => thread.id === trimmed);
	if (byId) return byId;
	if (/^\d+$/.test(trimmed)) {
		const byIndex = threads.find((thread) => thread.index === Number(trimmed));
		if (byIndex) return byIndex;
	}
	throw new CliError(
		"thread_not_found",
		`No thread ${trimmed}; the note has ${threads.length} thread${
			threads.length === 1 ? "" : "s"
		}. List them with comments:threads.`,
	);
}

export function isSuggestionThread(thread: ThreadInfo): boolean {
	return (
		thread.kind === "addition" ||
		thread.kind === "deletion" ||
		thread.kind === "substitution"
	);
}

/**
 * Where an exact quote sits in the note. With several occurrences the
 * caller must name the 1-based line; with none the error lists nothing.
 */
export function locateQuote(
	text: string,
	quote: string,
	line?: number,
): { from: number; to: number } {
	if (quote.length === 0) {
		throw new CliError("empty_quote", "quote= must name the passage to anchor to");
	}
	const hits: number[] = [];
	let cursor = text.indexOf(quote);
	while (cursor !== -1) {
		hits.push(cursor);
		cursor = text.indexOf(quote, cursor + 1);
	}
	const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
	const candidates = line === undefined ? hits : hits.filter((hit) => lineOf(hit) === line);
	if (candidates.length === 0) {
		throw new CliError(
			"quote_not_found",
			line === undefined
				? "The quoted text does not occur in the note"
				: `The quoted text does not occur on line ${line}`,
			{ occurrences: hits.map(lineOf) },
		);
	}
	if (candidates.length > 1) {
		throw new CliError(
			"ambiguous_quote",
			`The quoted text occurs ${candidates.length} times; add line=<n> to pick one`,
			{ occurrences: candidates.map(lineOf) },
		);
	}
	return { from: candidates[0], to: candidates[0] + quote.length };
}

/**
 * Whether a new mark can wrap the range: CriticMarkup cannot nest, and a
 * partial overlap with a native highlight would split its delimiters.
 * Returns the native highlight when the range is exactly its passage.
 */
export function checkAnchorRange(
	text: string,
	from: number,
	to: number,
): NativeHighlight | null {
	const marks = parseCriticMarkup(text);
	if (marks.some((mark) => mark.from < to && mark.to > from)) {
		throw new CliError(
			"overlaps_mark",
			"That passage already contains a suggestion or comment; reply to its thread instead",
		);
	}
	const highlights = parseNativeHighlights(text, marks);
	const exact =
		highlights.find(
			(highlight) =>
				(highlight.contentFrom === from && highlight.contentTo === to) ||
				(highlight.from === from && highlight.to === to),
		) ?? null;
	if (exact) return exact;
	if (highlights.some((highlight) => highlight.from < to && highlight.to > from)) {
		throw new CliError(
			"overlaps_highlight",
			"Quote the entire highlighted passage to comment on it",
		);
	}
	return null;
}

/** The run that owns a native highlight, so a comment lands after its thread. */
export function runEndForHighlight(text: string, highlight: NativeHighlight): number {
	const { threads } = projectThreads(text);
	const owner = threads.find(
		(thread) => thread.kind === "native-highlight" && thread.id === highlight.id,
	);
	return owner?.to ?? highlight.to;
}

/**
 * Resolve a thread the way the sidebar does: comments go, the anchor
 * survives when it is a suggestion or a native highlight, and a CriticMarkup
 * highlight unwraps to its passage.
 */
export function planResolve(text: string, thread: ThreadInfo): TextChange[] {
	if (thread.kind === "native-highlight") {
		if (thread.comments.length === 0) {
			throw new CliError(
				"nothing_to_resolve",
				"That native highlight has no comments; it is ordinary Markdown",
			);
		}
		return [{ from: thread.anchorTo, to: thread.to, insert: "" }];
	}
	if (thread.kind === "comment") {
		return [{ from: thread.from, to: thread.to, insert: "" }];
	}
	if (isSuggestionThread(thread)) {
		if (thread.comments.length === 0) {
			throw new CliError(
				"nothing_to_resolve",
				"That suggestion has no comments; accept or reject it instead",
			);
		}
		return [{ from: thread.anchorTo, to: thread.to, insert: "" }];
	}
	const mark = anchorMark(text, thread);
	return [{ from: thread.from, to: thread.to, insert: replacementForMark(mark, "accept") }];
}

/** Accept or reject a suggestion, dropping its attached comments. */
export function planSuggestionAction(
	text: string,
	thread: ThreadInfo,
	action: CriticAction,
): TextChange[] {
	if (!isSuggestionThread(thread)) {
		throw new CliError(
			"not_a_suggestion",
			`Thread ${thread.index} is a ${thread.kind}; use comments:resolve`,
		);
	}
	const mark = anchorMark(text, thread);
	if (!isSuggestionMark(mark)) {
		throw new CliError("not_a_suggestion", `Thread ${thread.index} is not a suggestion`);
	}
	return [{ from: thread.from, to: thread.to, insert: replacementForMark(mark, action) }];
}

function anchorMark(text: string, thread: ThreadInfo): CriticMark {
	const mark = parseCriticMarkup(text).find(
		(candidate) => candidate.valid && candidate.id === thread.id,
	);
	if (!mark) {
		throw new CliError("thread_not_found", `Thread ${thread.index} changed while editing; list again`);
	}
	return mark;
}

/** Apply non-overlapping changes, last first so earlier offsets hold. */
export function applyChanges(text: string, changes: TextChange[]): string {
	const ordered = changes.slice().sort((a, b) => b.from - a.from);
	let out = text;
	for (const change of ordered) {
		out = out.slice(0, change.from) + change.insert + out.slice(change.to);
	}
	return out;
}
