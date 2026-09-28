import type { CliData, CliFlags } from "obsidian";
import type { CanvasComment } from "../canvas/comments-data";
import { sanitizeCommentText } from "../critic/comment-text";
import { CRITIC_SECTION_SEPARATOR } from "../critic/threading";
import type { CriticAction } from "../critic/transform";
import { buildCommentDraftInsertion } from "../editor/comment-draft-anchor";
import { formatAuthoredComment } from "../identity/markup";
import {
	REVIEW_MARK_KINDS,
	type ReviewEvent,
	type ReviewMarkKind,
	type ReviewMarkSummary,
	type WatchFilter,
} from "./events";
import {
	cardForQuote,
	cardText,
	cardThread,
	findNode,
	isCanvasPath,
	openPin,
	parseCanvas,
	projectCanvasThreads,
	replaceNode,
	replyToPin,
	resolvePin,
	type CanvasDoc,
} from "./canvas";
import { clip, kv } from "./format";
import { flag, number, optional, required, text, vaultPath } from "./params";
import {
	applyChanges,
	checkAnchorRange,
	findThread,
	locateQuote,
	planResolve,
	planSuggestionAction,
	projectThreads,
	runEndForHighlight,
	type NoteThreads,
	type ThreadInfo,
} from "./threads";
import {
	CliError,
	type CliCommand,
	type CliContext,
	type CliResult,
	type EditOptions,
	type TextChange,
} from "./types";

const PATH_FLAG: CliFlags = {
	path: { value: "<note|canvas>", description: "Vault path of the note or canvas", required: true },
};
const NODE_FLAG: CliFlags = {
	node: {
		value: "<id>",
		description:
			"On a canvas: the node to pin a comment to, or the text card to search for the quote",
	},
};
const THREAD_FLAG: CliFlags = {
	thread: {
		value: "<n|id>",
		description: "Thread number or anchor id from comments:threads",
		required: true,
	},
};
const AUTHOR_FLAG: CliFlags = {
	author: {
		value: "<name>",
		description:
			"Sign and act as this identity (an id or name from the identity directory, or a display name); edits as anyone but you stay out of your undo history",
	},
};
const QUOTE_FLAGS: CliFlags = {
	quote: {
		value: "<text>",
		description: "The exact passage to anchor to, in the note or in a canvas text card",
	},
	line: {
		value: "<n>",
		description:
			"1-based line of the passage (within the card on a canvas), when the quote occurs more than once",
	},
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveNote(ctx: CliContext, input: string): string {
	const path = ctx.notes.resolveWatchable(input);
	if (!path) {
		throw new CliError("note_not_found", `No note or canvas at ${vaultPath(input)}`);
	}
	return path;
}

async function readNote(ctx: CliContext, path: string): Promise<string> {
	const content = await ctx.notes.read(path);
	if (content === null) {
		throw new CliError("note_not_found", `No Markdown note at ${path}`);
	}
	return content;
}

interface Signature {
	id?: string;
	name?: string;
	source: string;
	/** True when this identity is the user's own, so the edit is theirs to undo. */
	asUser: boolean;
}

async function signature(
	ctx: CliContext,
	path: string,
	params: CliData,
): Promise<Signature> {
	const user = await ctx.identity(path);
	const mine = user.source === "fallback" ? null : user;
	const override = optional(params, "author");
	if (override) {
		const known = ctx
			.identities()
			.find((identity) => identity.id === override || identity.name === override);
		const id = known?.id;
		const name = known?.name ?? override;
		const asUser =
			mine !== null &&
			((id !== undefined && id === mine.id) ||
				override === mine.id ||
				(name !== undefined && name === mine.name));
		return known
			? { id, name, source: "configured", asUser }
			: { name: override, source: "flag", asUser };
	}
	return mine
		? { id: mine.id, name: mine.name, source: mine.source, asUser: true }
		: { source: "fallback", asUser: true };
}

function commentMarkup(ctx: CliContext, body: string, signer: Signature): string {
	return `${CRITIC_SECTION_SEPARATOR}${formatAuthoredComment(
		sanitizeCommentText(body),
		signer.id,
		signer.name,
		ctx.now().toISOString(),
	)}`;
}

function signerData(signer: Signature): Record<string, unknown> {
	return {
		signedAs: signer.name ?? signer.id ?? null,
		identitySource: signer.source,
		undoable: signer.asUser,
	};
}

function describeSigner(signer: Signature): string {
	if (!signer.name && !signer.id) return "unsigned (no identity configured)";
	return `as ${signer.name ?? signer.id}`;
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

function threadHeading(thread: ThreadInfo): string {
	const where = [
		thread.node !== undefined ? `node ${thread.node}` : null,
		thread.line !== undefined ? `L${thread.line}` : null,
	]
		.filter((part) => part !== null)
		.join(" ");
	switch (thread.kind) {
		case "pin":
			return `${thread.index}. pin ${where}`;
		case "substitution":
			return `${thread.index}. substitution ${where} "${clip(thread.oldText ?? "")}" → "${clip(thread.newText ?? "")}"`;
		case "comment":
			return `${thread.index}. comment ${where}`;
		case "native-highlight":
			return `${thread.index}. highlight ${where} "${clip(thread.text)}"`;
		default:
			return `${thread.index}. ${thread.kind} ${where} "${clip(thread.text)}"`;
	}
}

function commentLine(comment: { author?: string; date?: string; text: string }): string {
	const who = comment.author ?? "(unsigned)";
	const when = comment.date ? ` · ${comment.date.slice(0, 10)}` : "";
	return `   ${who}${when}: ${clip(comment.text, 200)}`;
}

function renderThread(thread: ThreadInfo): string {
	const lines = [threadHeading(thread) + (thread.resolved ? " [resolved]" : "")];
	for (const comment of thread.comments) lines.push(commentLine(comment));
	return lines.join("\n");
}

function renderNoteThreads(path: string, note: NoteThreads): string {
	const count = note.threads.length;
	const lines = [`${path}: ${count} thread${count === 1 ? "" : "s"}`];
	for (const thread of note.threads) lines.push(renderThread(thread));
	if (note.invalid.length > 0) {
		lines.push("Invalid CriticMarkup:");
		for (const mark of note.invalid) {
			const where = mark.node !== undefined ? `node ${mark.node} L${mark.line}` : `L${mark.line}`;
			lines.push(`   ${where}: ${mark.error} ${clip(mark.raw, 80)}`);
		}
	}
	return lines.join("\n");
}

function renderMark(prefix: string, mark: ReviewMarkSummary): string {
	const who = mark.author ? `${mark.author}: ` : "";
	const where = [
		mark.node !== undefined ? `node ${mark.node}` : null,
		mark.line !== undefined ? `L${mark.line}` : null,
	]
		.filter((part) => part !== null)
		.join(" ");
	const state = mark.kind === "pin" ? (mark.resolved ? " [resolved]" : " [open]") : "";
	return `  ${prefix} ${mark.kind}${where ? ` ${where}` : ""}${state} ${who}"${clip(mark.text, 160)}"`;
}

function renderEvent(event: ReviewEvent): string {
	const head =
		event.type === "renamed"
			? `#${event.seq} renamed ${event.from ?? "?"} → ${event.path}`
			: `#${event.seq} ${event.type} ${event.path} (${event.marks} mark${
					event.marks === 1 ? "" : "s"
				})`;
	const lines = [head];
	for (const mark of event.added) lines.push(renderMark("+", mark));
	for (const mark of event.removed) lines.push(renderMark("-", mark));
	return lines.join("\n");
}


function list(params: CliData, key: string): string[] {
	const value = optional(params, key);
	if (value === undefined) return [];
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function watchFilter(params: CliData): WatchFilter | undefined {
	const kinds = list(params, "kind");
	for (const kind of kinds) {
		if (!REVIEW_MARK_KINDS.includes(kind as ReviewMarkKind)) {
			throw new CliError(
				"invalid_value",
				`kind must be one or more of ${REVIEW_MARK_KINDS.join(", ")}, got "${kind}"`,
			);
		}
	}
	const ignoreAuthors = list(params, "ignore-author");
	if (kinds.length === 0 && ignoreAuthors.length === 0) return undefined;
	return {
		kinds: new Set(kinds as ReviewMarkKind[]),
		ignoreAuthors: new Set(ignoreAuthors),
	};
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const status: CliCommand = {
	id: "comments",
	description: "Relay Comments status: version, signing identity, identity directory, and watch state",
	flags: {
		path: { value: "<note>", description: "Resolve the identity for this note" },
	},
	async run(params, ctx) {
		const input = optional(params, "path");
		const path = input ? resolveNote(ctx, input) : "";
		const identity = await ctx.identity(path);
		const directory = ctx.identities().map(({ id, name }) => ({ id, name }));
		const data = {
			version: ctx.version,
			identity:
				identity.source === "fallback"
					? null
					: { id: identity.id ?? null, name: identity.name ?? null, source: identity.source },
			identities: directory,
			cursor: ctx.events.cursor,
			watching: ctx.events.armedScopes.map((scope) => scope || "/"),
			trackedNotes: ctx.events.trackedNotes,
			waiters: ctx.events.pendingWaiters,
		};
		return {
			data,
			text: kv([
				["version", ctx.version],
				[
					"identity",
					data.identity
						? `${data.identity.name ?? data.identity.id} (${data.identity.source})`
						: "none configured",
				],
				["identities", directory.map((entry) => `${entry.name} [${entry.id}]`).join(", ") || "(none)"],
				["cursor", data.cursor],
				["watching", data.watching.join(", ") || "(nothing yet)"],
				["tracked notes", data.trackedNotes],
				["waiting", data.waiters],
			]),
		};
	},
};

const threads: CliCommand = {
	id: "comments:threads",
	description: "List the comment threads and suggestions in a note, a canvas, or a folder",
	flags: {
		path: {
			value: "<note|canvas|folder>",
			description: "A note, a canvas, or a folder to scan",
			required: true,
		},
		open: { description: "Only threads that are not resolved" },
	},
	async run(params, ctx) {
		const input = required(params, "path");
		const openOnly = flag(params, "open");
		const filter = (note: NoteThreads): NoteThreads =>
			openOnly
				? { ...note, threads: note.threads.filter((thread) => !thread.resolved) }
				: note;
		const filePath = ctx.notes.resolveWatchable(input);
		if (filePath) {
			const note = filter(await loadThreads(ctx, filePath));
			return {
				data: { path: filePath, ...note },
				text: renderNoteThreads(filePath, note),
			};
		}
		if (!ctx.notes.isFolder(input)) {
			throw new CliError("note_not_found", `No note, canvas, or folder at ${vaultPath(input)}`);
		}
		const folder = vaultPath(input);
		const notes: Array<{ path: string } & NoteThreads> = [];
		for (const path of ctx.notes.watchable(folder || null)) {
			let note: NoteThreads;
			try {
				note = filter(await loadThreads(ctx, path));
			} catch {
				continue;
			}
			if (note.threads.length === 0 && note.invalid.length === 0) continue;
			notes.push({ path, ...note });
		}
		return {
			data: { folder: folder || "/", notes },
			text:
				notes.length === 0
					? `No threads under ${folder || "/"}`
					: notes.map((note) => renderNoteThreads(note.path, note)).join("\n\n"),
		};
	},
};

/** The threads in a note or on a canvas. */
async function loadThreads(ctx: CliContext, path: string): Promise<NoteThreads> {
	const content = await readNote(ctx, path);
	return isCanvasPath(path) ? projectCanvasThreads(parseCanvas(content)) : projectThreads(content);
}

/** Identifies the thread a write produced, to print it back. */
interface ThreadLocator {
	node?: string;
	anchorFrom?: number;
	id?: string;
}

function locate(note: NoteThreads, locator: ThreadLocator | null): ThreadInfo | undefined {
	if (!locator) return undefined;
	return note.threads.find((thread) =>
		locator.id !== undefined
			? thread.id === locator.id
			: thread.node === locator.node && thread.anchorFrom === locator.anchorFrom,
	);
}

async function threadResult(
	ctx: CliContext,
	path: string,
	locator: ThreadLocator | null,
	verb: string,
	extra: Record<string, unknown> = {},
): Promise<CliResult> {
	const note = await loadThreads(ctx, path);
	const thread = locate(note, locator);
	return {
		data: { path, thread: thread ?? null, threads: note.threads.length, ...extra },
		text: thread
			? `${verb} ${path}\n${renderThread(thread)}`
			: `${verb} ${path}; ${
					note.threads.length === 1 ? "1 thread remains" : `${note.threads.length} threads remain`
				}`,
	};
}

/** The comment a pin stores, signed the way the pin UI signs it. */
function pinComment(ctx: CliContext, body: string, signer: Signature): CanvasComment {
	return {
		author: signer.name ?? signer.id ?? "Unknown author",
		...(signer.id ? { authorId: signer.id } : {}),
		date: ctx.now().toISOString(),
		text: body.trim(),
	};
}

/**
 * Plan a text edit against a note, or against one text card on a canvas.
 * `card` picks the card from the current canvas; it is not called for notes.
 */
async function editText(
	ctx: CliContext,
	path: string,
	card: ((doc: CanvasDoc) => string) | null,
	plan: (text: string) => TextChange[],
	options: EditOptions,
): Promise<string | undefined> {
	if (!isCanvasPath(path)) {
		await ctx.notes.edit(path, plan, options);
		return undefined;
	}
	if (!card) throw new CliError("invalid_value", "Name a text card or a thread on this canvas");
	let node: string | undefined;
	await ctx.notes.editCanvas(path, (doc) => {
		node = card(doc);
		const current = cardText(doc, node);
		const target = findNode(doc, node);
		return replaceNode(doc, node, { ...target, text: applyChanges(current, plan(current)) });
	}, options);
	return node;
}

/** Comment on a quoted passage: the shared plan for notes and text cards. */
function planComment(content: string, range: { from: number; to: number }, markup: string): {
	changes: TextChange[];
	anchorFrom: number;
} {
	const native = checkAnchorRange(content, range.from, range.to);
	if (native) {
		const at = runEndForHighlight(content, native);
		return { changes: [{ from: at, to: at, insert: markup }], anchorFrom: native.from };
	}
	return {
		changes: [
			{
				from: range.from,
				to: range.to,
				insert: buildCommentDraftInsertion(content.slice(range.from, range.to), markup),
			},
		],
		anchorFrom: range.from,
	};
}

const comment: CliCommand = {
	id: "comments:comment",
	description:
		"Open a comment thread on a passage, or on a canvas, pin a comment to a node",
	flags: {
		...PATH_FLAG,
		...QUOTE_FLAGS,
		...NODE_FLAG,
		text: { value: "<comment>", description: "The comment body", required: true },
		...AUTHOR_FLAG,
	},
	async run(params, ctx) {
		const path = resolveNote(ctx, required(params, "path"));
		const quote = params.quote === undefined ? undefined : text(params, "quote");
		const line = number(params, "line");
		const nodeRef = optional(params, "node");
		const body = text(params, "text");
		const signer = await signature(ctx, path, params);
		const verb = `Commented ${describeSigner(signer)} in`;
		if (isCanvasPath(path) && quote === undefined) {
			if (!nodeRef) {
				throw new CliError(
					"missing_flag",
					"On a canvas, pass node=<id> to pin a comment, or quote=<text> to comment in a text card",
				);
			}
			let pinId = "";
			await ctx.notes.editCanvas(
				path,
				(doc) => {
					const opened = openPin(doc, nodeRef, pinComment(ctx, body, signer));
					pinId = opened.thread;
					return opened.doc;
				},
				signer,
			);
			return threadResult(ctx, path, { id: pinId }, verb, signerData(signer));
		}
		if (quote === undefined) throw new CliError("missing_flag", "Missing required parameter: quote=<value>");
		const markup = commentMarkup(ctx, body, signer);
		let anchorFrom = -1;
		let range: { from: number; to: number } | null = null;
		const node = await editText(
			ctx,
			path,
			(doc) => {
				const found = cardForQuote(doc, quote, nodeRef, line);
				range = found.range;
				return found.node;
			},
			(content) => {
				const planned = planComment(content, range ?? locateQuote(content, quote, line), markup);
				anchorFrom = planned.anchorFrom;
				return planned.changes;
			},
			signer,
		);
		return threadResult(ctx, path, { node, anchorFrom }, verb, signerData(signer));
	},
};

/** A thread from the current document, and the card it lives in on a canvas. */
function canvasThread(doc: CanvasDoc, ref: string): ThreadInfo {
	return findThread(projectCanvasThreads(doc).threads, ref);
}

const reply: CliCommand = {
	id: "comments:reply",
	description: "Append a reply to a thread, including a canvas pin",
	flags: {
		...PATH_FLAG,
		...THREAD_FLAG,
		text: { value: "<reply>", description: "The reply body", required: true },
		...AUTHOR_FLAG,
	},
	async run(params, ctx) {
		const path = resolveNote(ctx, required(params, "path"));
		const ref = required(params, "thread");
		const body = text(params, "text");
		const signer = await signature(ctx, path, params);
		const verb = `Replied ${describeSigner(signer)} in`;
		if (isCanvasPath(path)) {
			let target: ThreadInfo | null = null;
			await ctx.notes.editCanvas(path, (doc) => {
				const thread = canvasThread(doc, ref);
				target = thread;
				if (thread.kind === "pin") return replyToPin(doc, thread, pinComment(ctx, body, signer));
				const node = thread.node ?? "";
				const current = cardText(doc, node);
				const markup = commentMarkup(ctx, body, signer);
				return replaceNode(doc, node, {
					...findNode(doc, node),
					text: applyChanges(current, [{ from: thread.to, to: thread.to, insert: markup }]),
				});
			}, signer);
			const done = target as ThreadInfo | null;
			const locator: ThreadLocator | null = done
				? done.kind === "pin"
					? { id: done.id }
					: { node: done.node, anchorFrom: done.anchorFrom }
				: null;
			return threadResult(ctx, path, locator, verb, signerData(signer));
		}
		const markup = commentMarkup(ctx, body, signer);
		let anchorFrom = -1;
		await ctx.notes.edit(
			path,
			(content) => {
				const thread = findThread(projectThreads(content).threads, ref);
				anchorFrom = thread.anchorFrom;
				return [{ from: thread.to, to: thread.to, insert: markup }];
			},
			signer,
		);
		return threadResult(ctx, path, { anchorFrom }, verb, signerData(signer));
	},
};

/**
 * Apply a planner to the thread a reference names, in a note or in the
 * text card that holds it. Pins go to `onPin`, or are refused.
 */
async function actOnThread(
	ctx: CliContext,
	path: string,
	ref: string,
	options: EditOptions,
	plan: (text: string, thread: ThreadInfo) => TextChange[],
	onPin?: (doc: CanvasDoc, thread: ThreadInfo) => CanvasDoc,
): Promise<ThreadInfo | null> {
	let acted: ThreadInfo | null = null;
	if (!isCanvasPath(path)) {
		await ctx.notes.edit(
			path,
			(content) => {
				acted = findThread(projectThreads(content).threads, ref);
				return plan(content, acted);
			},
			options,
		);
		return acted;
	}
	await ctx.notes.editCanvas(path, (doc) => {
		const thread = canvasThread(doc, ref);
		acted = thread;
		if (thread.kind === "pin") {
			if (!onPin) {
				throw new CliError(
					"not_a_suggestion",
					`Thread ${thread.index} is a comment pin; use comments:resolve`,
				);
			}
			return onPin(doc, thread);
		}
		const node = thread.node ?? "";
		const current = cardText(doc, node);
		return replaceNode(doc, node, {
			...findNode(doc, node),
			text: applyChanges(current, plan(current, cardThread(thread))),
		});
	}, options);
	return acted;
}

const resolve: CliCommand = {
	id: "comments:resolve",
	description:
		"Resolve a thread: remove its comments and unwrap a highlight, or mark a canvas pin resolved",
	flags: { ...PATH_FLAG, ...THREAD_FLAG, ...AUTHOR_FLAG },
	async run(params, ctx) {
		const path = resolveNote(ctx, required(params, "path"));
		const ref = required(params, "thread");
		const actor = await signature(ctx, path, params);
		const resolved = await actOnThread(
			ctx,
			path,
			ref,
			actor,
			(content, thread) => planResolve(content, thread),
			(doc, thread) => resolvePin(doc, thread),
		);
		const locator = resolved?.kind === "pin" ? { id: resolved.id } : null;
		return threadResult(ctx, path, locator, "Resolved thread in", {
			resolved,
			undoable: actor.asUser,
		});
	},
};

function suggestionAction(action: CriticAction): CliCommand {
	const verb = action === "accept" ? "Accepted" : "Rejected";
	return {
		id: `comments:${action}`,
		description: `${verb.replace(/ed$/, "")} a suggested edit and drop its comments`,
		flags: { ...PATH_FLAG, ...THREAD_FLAG, ...AUTHOR_FLAG },
		async run(params, ctx) {
			const path = resolveNote(ctx, required(params, "path"));
			const ref = required(params, "thread");
			const actor = await signature(ctx, path, params);
			const applied = await actOnThread(ctx, path, ref, actor, (content, thread) =>
				planSuggestionAction(content, thread, action),
			);
			return threadResult(ctx, path, null, `${verb} suggestion in`, {
				applied,
				undoable: actor.asUser,
			});
		},
	};
}

const suggest: CliCommand = {
	id: "comments:suggest",
	description: "Suggest an edit to a passage: a replacement, an insertion after it, or its deletion",
	flags: {
		...PATH_FLAG,
		...QUOTE_FLAGS,
		...NODE_FLAG,
		replace: { value: "<text>", description: "Replace the passage with this text" },
		insert: { value: "<text>", description: "Insert this text after the passage" },
		delete: { description: "Delete the passage" },
		comment: { value: "<text>", description: "Attach a comment explaining the suggestion" },
		...AUTHOR_FLAG,
	},
	async run(params, ctx) {
		const path = resolveNote(ctx, required(params, "path"));
		const quote = text(params, "quote");
		const line = number(params, "line");
		const nodeRef = optional(params, "node");
		const replacement = optional(params, "replace");
		const insertion = optional(params, "insert");
		const deletion = flag(params, "delete");
		const modes = [replacement !== undefined, insertion !== undefined, deletion].filter(Boolean);
		if (modes.length !== 1) {
			throw new CliError(
				"invalid_value",
				"Pass exactly one of replace=<text>, insert=<text>, or --delete",
			);
		}
		const note = optional(params, "comment");
		const signer = await signature(ctx, path, params);
		const trailing = note ? commentMarkup(ctx, text(params, "comment"), signer) : "";
		let anchorFrom = -1;
		let range: { from: number; to: number } | null = null;
		const node = await editText(
			ctx,
			path,
			(doc) => {
				const found = cardForQuote(doc, quote, nodeRef, line);
				range = found.range;
				return found.node;
			},
			(content) => {
				const at = range ?? locateQuote(content, quote, line);
				checkAnchorRange(content, at.from, at.to);
				const passage = content.slice(at.from, at.to);
				const mark = deletion
					? `{--${passage}--}`
					: replacement !== undefined
						? `{~~${passage}~>${text(params, "replace")}~~}`
						: `${passage}{++${text(params, "insert")}++}`;
				anchorFrom = deletion || replacement !== undefined ? at.from : at.to;
				return [{ from: at.from, to: at.to, insert: `${mark}${trailing}` }];
			},
			signer,
		);
		return threadResult(
			ctx,
			path,
			{ node, anchorFrom },
			"Suggested in",
			note ? signerData(signer) : { undoable: signer.asUser },
		);
	},
};

const watch: CliCommand = {
	id: "comments:watch",
	description:
		"Wait for the next comment, reply, resolution, or suggestion, then print it with a cursor to resume from",
	flags: {
		path: {
			value: "<note|canvas|folder>",
			description: "Watch one note, one canvas, or a folder (default: the whole vault)",
		},
		since: { value: "<cursor>", description: "Return events after this cursor instead of waiting" },
		timeout: { value: "<seconds>", description: "Give up after this long (default: wait indefinitely)" },
		kind: {
			value: "<kinds>",
			description:
				"Only these mark kinds, comma separated: comment, highlight, addition, deletion, substitution, pin",
		},
		"ignore-author": {
			value: "<names>",
			description: "Skip changes signed only by these authors (names or ids, comma separated), e.g. your own",
		},
		any: { description: "Also return on edits that leave the marks unchanged" },
	},
	async run(params, ctx) {
		const input = optional(params, "path");
		let scope: string | null = null;
		if (input !== undefined) {
			const file = ctx.notes.resolveWatchable(input);
			if (file) scope = file;
			else if (ctx.notes.isFolder(input)) scope = vaultPath(input) || null;
			else throw new CliError("note_not_found", `No note, canvas, or folder at ${vaultPath(input)}`);
		}
		const since = number(params, "since") ?? null;
		const timeout = number(params, "timeout");
		const filter = watchFilter(params);
		ctx.events.arm(scope);
		for (const path of ctx.notes.watchable(scope)) {
			if (ctx.events.hasSnapshot(path)) continue;
			ctx.events.baseline(path, (await ctx.notes.read(path)) ?? "");
		}
		const result = await ctx.events.wait({
			scope,
			since,
			timeoutMs: timeout === undefined ? null : Math.round(timeout * 1000),
			anyChange: flag(params, "any"),
			filter,
		});
		const label = scope ?? "/";
		const lines =
			result.events.length === 0
				? [
						result.timedOut
							? `No review changes in ${label} within ${timeout ?? "?"}s`
							: `No review changes in ${label}`,
					]
				: result.events.map(renderEvent);
		if (result.gap) lines.push("(some earlier events were dropped; list threads to catch up)");
		lines.push(`cursor: ${result.cursor}`);
		return {
			data: {
				scope: label,
				cursor: result.cursor,
				events: result.events,
				timedOut: result.timedOut,
				gap: result.gap,
			},
			text: lines.join("\n"),
		};
	},
};

export const CLI_COMMANDS: CliCommand[] = [
	status,
	threads,
	watch,
	comment,
	reply,
	resolve,
	suggestionAction("accept"),
	suggestionAction("reject"),
	suggest,
];
