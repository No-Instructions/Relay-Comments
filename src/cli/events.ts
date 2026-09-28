import { parseCriticMarkup } from "../critic/parse";
import type { CriticMark, CriticMarkType } from "../critic/types";
import { highlightPresentation } from "../markdown/highlights";

/**
 * The review-mark change log behind `comments:watch`.
 *
 * A scope (a note, a folder, or the vault) is armed the first time a
 * caller watches it and stays armed while the plugin runs. Only notes
 * under an armed scope are snapshotted and diffed, so a vault with one
 * watched folder parses that folder's notes and nothing else. Feeding new
 * text through `ingest` diffs it against the snapshot and, when a mark
 * was added or removed, appends a numbered event and wakes every waiter
 * whose scope and filter match. Ordinary typing that leaves the marks
 * alone produces no event. The sequence number doubles as the cursor a
 * caller hands back to resume without missing anything between calls.
 *
 * Markdown notes and canvases are both watched. A canvas contributes its
 * comment pins (one `pin` per thread, carrying its resolved state, plus
 * each comment in it) and any CriticMarkup inside its text cards.
 *
 * Pure TypeScript: no Obsidian, timers come from the constructor.
 */

/** A CriticMarkup kind, or `pin` for a canvas comment thread. */
export type ReviewMarkKind = CriticMarkType | "pin";

export const REVIEW_MARK_KINDS: ReviewMarkKind[] = [
	"comment",
	"highlight",
	"addition",
	"deletion",
	"substitution",
	"pin",
];

export interface ReviewMarkSummary {
	kind: ReviewMarkKind;
	/** 1-based line of the mark's opening delimiter; within the card on a canvas. Absent for pins and their comments. */
	line?: number;
	/** On a canvas: the id of the node the mark or pin belongs to. */
	node?: string;
	/** On a canvas: the pin thread a comment belongs to. */
	thread?: string;
	/** On a canvas pin: whether the thread is resolved. */
	resolved?: boolean;
	/** What a reader sees: the passage, the body, or "old → new". */
	text: string;
	author?: string;
	authorId?: string;
	date?: string;
	/** The mark's source, shortened past `maxChars`. */
	raw: string;
}

export type ReviewEventType = "changed" | "created" | "deleted" | "renamed" | "edited";

export interface ReviewEvent {
	seq: number;
	time: string;
	type: ReviewEventType;
	path: string;
	/** For `renamed`: the previous path. */
	from?: string;
	added: ReviewMarkSummary[];
	removed: ReviewMarkSummary[];
	/** Valid marks in the note after the change. */
	marks: number;
}

export interface WatchFilter {
	/** Only these mark kinds count. Empty or absent means every kind. */
	kinds?: ReadonlySet<ReviewMarkKind>;
	/**
	 * Authors (name or id) whose own marks do not count. An event whose
	 * signed marks are all by these authors is skipped, together with the
	 * unsigned highlight or suggestion those marks came with.
	 */
	ignoreAuthors?: ReadonlySet<string>;
}

export interface WatchResult {
	cursor: number;
	events: ReviewEvent[];
	timedOut: boolean;
	/** True when events between `since` and the oldest kept one were dropped. */
	gap: boolean;
}

export interface WatchRequest {
	/** A note path, a folder path, or null for the whole vault. */
	scope: string | null;
	/** Return events after this sequence number; null means "from now". */
	since: number | null;
	timeoutMs: number | null;
	/** Also return edits that leave the marks unchanged. Never buffered. */
	anyChange: boolean;
	filter?: WatchFilter;
}

export interface EventTimers {
	setTimeout(callback: () => void, ms: number): number;
	clearTimeout(id: number): void;
}

export interface ReviewEventLogOptions {
	/** Events kept for late readers. Older ones fall off and report a gap. */
	capacity?: number;
	/** Longest `raw` returned in a summary. */
	maxChars?: number;
	/** Most events one wait returns at once. */
	batch?: number;
	now?: () => Date;
	/** Timers for wait timeouts; the plugin passes its window's. */
	timers: EventTimers;
}

interface Snapshot {
	hash: number;
	marks: Map<string, ReviewMarkSummary>;
	count: number;
}

interface Waiter {
	request: WatchRequest;
	resolve: (result: WatchResult) => void;
	timer: number | null;
}

/** The files the event log understands. */
export function isWatchablePath(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".canvas");
}

export function scopeContains(scope: string | null, path: string): boolean {
	if (scope === null || scope === "") return true;
	return path === scope || path.startsWith(`${scope}/`);
}

export function summarizeMark(mark: CriticMark, maxChars: number): ReviewMarkSummary {
	const summary: ReviewMarkSummary = {
		kind: mark.type,
		line: mark.line + 1,
		text: markText(mark),
		raw: shorten(mark.raw, maxChars),
	};
	const metadata = mark.metadata;
	if (metadata?.author) summary.author = metadata.author;
	if (metadata?.authorId) summary.authorId = metadata.authorId;
	if (metadata?.date) summary.date = metadata.date;
	return summary;
}

export function markText(mark: CriticMark): string {
	switch (mark.type) {
		case "substitution":
			return `${mark.oldText ?? ""} → ${mark.newText ?? ""}`;
		case "highlight":
			return highlightPresentation(mark.content).text;
		default:
			return mark.content;
	}
}

function shorten(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

/** FNV-1a over the text, enough to notice an edit without keeping the text. */
export function hashText(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function addKeyed(
	keys: Map<string, ReviewMarkSummary>,
	base: string,
	summary: ReviewMarkSummary,
): void {
	let n = 0;
	while (keys.has(`${base}\u0000${n}`)) n += 1;
	keys.set(`${base}\u0000${n}`, summary);
}

/**
 * A mark's identity is its kind plus its exact source, not its position,
 * so edits elsewhere in the note do not count as mark changes. Duplicate
 * marks get a running suffix so two identical comments stay two marks.
 */
export function markKeys(
	marks: readonly CriticMark[],
	maxChars: number,
	node?: string,
): Map<string, ReviewMarkSummary> {
	const keys = new Map<string, ReviewMarkSummary>();
	for (const mark of marks) {
		if (!mark.valid) continue;
		const summary = summarizeMark(mark, maxChars);
		if (node !== undefined) summary.node = node;
		addKeyed(keys, `${node ?? ""}\u0000${mark.type}\u0000${mark.raw.split(/\s+/).join(" ")}`, summary);
	}
	return keys;
}

interface CanvasCommentLike {
	author?: unknown;
	authorId?: unknown;
	date?: unknown;
	text?: unknown;
}

interface CanvasThreadLike {
	id?: unknown;
	resolved?: unknown;
	comments?: unknown;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The review marks on a canvas: each pin thread as a `pin` keyed by its id
 * and resolved state, each of its comments, and CriticMarkup inside text
 * cards. A pin with no comments yet is a draft and is left out. Pins survive node moves because nothing positional is keyed.
 * Returns null when the file is not a canvas document, e.g. mid-write.
 */
export function canvasMarkKeys(
	text: string,
	maxChars: number,
): Map<string, ReviewMarkSummary> | null {
	let data: unknown;
	try {
		data = JSON.parse(text === "" ? "{}" : text);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const nodes = (data as { nodes?: unknown }).nodes;
	const keys = new Map<string, ReviewMarkSummary>();
	if (!Array.isArray(nodes)) return keys;
	for (const entry of nodes) {
		if (!entry || typeof entry !== "object") continue;
		const node = entry as { id?: unknown; type?: unknown; text?: unknown; relayComments?: unknown };
		const nodeId = stringField(node.id) ?? "";
		if (node.type === "text" && typeof node.text === "string") {
			for (const [key, summary] of markKeys(parseCriticMarkup(node.text), maxChars, nodeId)) {
				keys.set(key, summary);
			}
		}
		if (!Array.isArray(node.relayComments)) continue;
		for (const rawThread of node.relayComments as CanvasThreadLike[]) {
			if (!rawThread || typeof rawThread !== "object") continue;
			const threadId = stringField(rawThread.id) ?? "";
			const resolved = rawThread.resolved === true;
			const comments = Array.isArray(rawThread.comments)
				? (rawThread.comments as CanvasCommentLike[]).filter(
						(comment) => comment && typeof comment === "object",
					)
				: [];
			// The pin UI saves a thread before its first comment is typed;
			// until something is posted it is a draft, not review activity.
			if (comments.length === 0) continue;
			const first = stringField(comments[0]?.text) ?? "";
			addKeyed(keys, `pin\u0000${threadId}\u0000${resolved}`, {
				kind: "pin",
				node: nodeId,
				thread: threadId,
				resolved,
				text: first,
				raw: shorten(JSON.stringify({ id: threadId, resolved }), maxChars),
			});
			for (const comment of comments) {
				const body = typeof comment.text === "string" ? comment.text : "";
				const summary: ReviewMarkSummary = {
					kind: "comment",
					node: nodeId,
					thread: threadId,
					text: body,
					raw: shorten(JSON.stringify(comment), maxChars),
				};
				const author = stringField(comment.author);
				const authorId = stringField(comment.authorId);
				const date = stringField(comment.date);
				if (author) summary.author = author;
				if (authorId) summary.authorId = authorId;
				if (date) summary.date = date;
				addKeyed(
					keys,
					`pin-comment\u0000${threadId}\u0000${author ?? ""}\u0000${date ?? ""}\u0000${body}`,
					summary,
				);
			}
		}
	}
	return keys;
}

/** The review marks in a watched file, or null when it cannot be read as one. */
export function reviewMarkKeys(
	path: string,
	text: string,
	maxChars: number,
): Map<string, ReviewMarkSummary> | null {
	if (path.toLowerCase().endsWith(".canvas")) return canvasMarkKeys(text, maxChars);
	return markKeys(parseCriticMarkup(text), maxChars);
}

/**
 * The part of an event a filter lets through, or null when nothing is
 * left. Renames and edits carry no marks and pass unless kinds are named.
 */
export function filterEvent(event: ReviewEvent, filter?: WatchFilter): ReviewEvent | null {
	if (!filter) return event;
	const kinds = filter.kinds && filter.kinds.size > 0 ? filter.kinds : null;
	const ignored = filter.ignoreAuthors && filter.ignoreAuthors.size > 0 ? filter.ignoreAuthors : null;
	if (event.added.length === 0 && event.removed.length === 0) {
		return kinds ? null : event;
	}
	const all = [...event.added, ...event.removed];
	const byIgnored = (mark: ReviewMarkSummary) =>
		ignored !== null &&
		((mark.author !== undefined && ignored.has(mark.author)) ||
			(mark.authorId !== undefined && ignored.has(mark.authorId)));
	const signed = all.filter((mark) => mark.author !== undefined || mark.authorId !== undefined);
	if (ignored && signed.length > 0 && signed.every(byIgnored)) return null;
	const keep = (mark: ReviewMarkSummary) => !byIgnored(mark) && (!kinds || kinds.has(mark.kind));
	const added = event.added.filter(keep);
	const removed = event.removed.filter(keep);
	if (added.length === 0 && removed.length === 0) return null;
	return { ...event, added, removed };
}

export class ReviewEventLog {
	private readonly capacity: number;
	private readonly maxChars: number;
	private readonly batch: number;
	private readonly now: () => Date;
	private readonly timers: EventTimers;
	private readonly snapshots = new Map<string, Snapshot>();
	private readonly scopes = new Set<string>();
	private readonly events: ReviewEvent[] = [];
	private waiters: Waiter[] = [];
	private seq = 0;

	constructor(options: ReviewEventLogOptions) {
		this.capacity = options.capacity ?? 1000;
		this.maxChars = options.maxChars ?? 400;
		this.batch = options.batch ?? 100;
		this.now = options.now ?? (() => new Date());
		this.timers = options.timers;
	}

	/** The sequence number of the latest event; the cursor for "from now". */
	get cursor(): number {
		return this.seq;
	}

	/** Scopes a caller has watched this session; their notes are tracked. */
	get armedScopes(): string[] {
		return [...this.scopes];
	}

	get pendingWaiters(): number {
		return this.waiters.length;
	}

	/** Notes currently snapshotted, i.e. read and parsed on change. */
	get trackedNotes(): number {
		return this.snapshots.size;
	}

	hasSnapshot(path: string): boolean {
		return this.snapshots.has(path);
	}

	/** True when a watched scope covers the path, so its changes are worth reading. */
	isArmed(path: string): boolean {
		if (this.scopes.has("")) return true;
		for (const scope of this.scopes) {
			if (scopeContains(scope, path)) return true;
		}
		return false;
	}

	arm(scope: string | null): void {
		const key = scope ?? "";
		if (this.scopes.has(key)) return;
		// A folder inside an armed folder adds nothing; an enclosing one replaces it.
		for (const existing of this.scopes) {
			if (scopeContains(existing, key) && existing !== key) return;
		}
		for (const existing of [...this.scopes]) {
			if (scopeContains(key, existing)) this.scopes.delete(existing);
		}
		this.scopes.add(key);
	}

	/** Record the marks in a note without reporting them. */
	baseline(path: string, text: string): void {
		const snapshot = this.snapshot(path, text);
		if (snapshot) this.snapshots.set(path, snapshot);
	}

	/**
	 * Diff new text against the note's snapshot. Notes outside every armed
	 * scope are ignored without parsing. A tracked-scope note the log has
	 * never seen is reported as created when it already carries marks.
	 */
	ingest(path: string, text: string): ReviewEvent | null {
		if (!this.isArmed(path)) return null;
		const previous = this.snapshots.get(path);
		const hash = hashText(text);
		if (previous && previous.hash === hash) return null;
		const next = this.snapshot(path, text, hash);
		if (!next) return null;
		this.snapshots.set(path, next);
		if (!previous) {
			if (next.count === 0) return null;
			return this.publish({
				type: "created",
				path,
				added: [...next.marks.values()],
				removed: [],
				marks: next.count,
			});
		}
		const added = diff(next.marks, previous.marks);
		const removed = diff(previous.marks, next.marks);
		if (added.length === 0 && removed.length === 0) {
			this.notifyEdited(path, next.count);
			return null;
		}
		return this.publish({ type: "changed", path, added, removed, marks: next.count });
	}

	remove(path: string): ReviewEvent | null {
		const previous = this.snapshots.get(path);
		this.snapshots.delete(path);
		if (!previous) return null;
		return this.publish({
			type: "deleted",
			path,
			added: [],
			removed: [...previous.marks.values()],
			marks: 0,
		});
	}

	rename(from: string, to: string): ReviewEvent | null {
		const previous = this.snapshots.get(from);
		if (!previous) return null;
		this.snapshots.delete(from);
		if (!this.isArmed(to)) {
			// Moved out of every watched scope: report it where it was.
			return this.publish({
				type: "deleted",
				path: from,
				added: [],
				removed: [...previous.marks.values()],
				marks: 0,
			});
		}
		this.snapshots.set(to, previous);
		return this.publish({
			type: "renamed",
			path: to,
			from,
			added: [],
			removed: [],
			marks: previous.count,
		});
	}

	/** Kept events after `since` that fall inside the scope and pass the filter. */
	eventsSince(
		since: number,
		scope: string | null,
		filter?: WatchFilter,
	): { events: ReviewEvent[]; gap: boolean } {
		const oldest = this.events[0]?.seq ?? this.seq + 1;
		const gap = since + 1 < oldest && this.seq > since;
		const events: ReviewEvent[] = [];
		for (const event of this.events) {
			if (event.seq <= since || !inScope(scope, event)) continue;
			const passed = filterEvent(event, filter);
			if (passed) events.push(passed);
			if (events.length >= this.batch) break;
		}
		return { events, gap };
	}

	/**
	 * Resolve with the events after `since` in the scope, immediately when
	 * some are already kept and otherwise as soon as the next one lands.
	 */
	wait(request: WatchRequest): Promise<WatchResult> {
		this.arm(request.scope);
		const since = request.since ?? this.seq;
		const kept = this.eventsSince(since, request.scope, request.filter);
		if (kept.events.length > 0) {
			return Promise.resolve({
				cursor: kept.events[kept.events.length - 1].seq,
				events: kept.events,
				timedOut: false,
				gap: kept.gap,
			});
		}
		return new Promise((resolve) => {
			const waiter: Waiter = { request, resolve, timer: null };
			if (request.timeoutMs !== null) {
				waiter.timer = this.timers.setTimeout(() => {
					this.waiters = this.waiters.filter((w) => w !== waiter);
					resolve({ cursor: this.seq, events: [], timedOut: true, gap: kept.gap });
				}, request.timeoutMs);
			}
			this.waiters.push(waiter);
		});
	}

	/** Release every waiter with an empty result, e.g. when the plugin unloads. */
	dispose(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) {
			if (waiter.timer !== null) this.timers.clearTimeout(waiter.timer);
			waiter.resolve({ cursor: this.seq, events: [], timedOut: true, gap: false });
		}
	}

	private snapshot(path: string, text: string, hash = hashText(text)): Snapshot | null {
		const marks = reviewMarkKeys(path, text, this.maxChars);
		return marks ? { hash, marks, count: marks.size } : null;
	}

	private publish(event: Omit<ReviewEvent, "seq" | "time">): ReviewEvent {
		this.seq += 1;
		const published: ReviewEvent = { seq: this.seq, time: this.now().toISOString(), ...event };
		this.events.push(published);
		if (this.events.length > this.capacity) {
			this.events.splice(0, this.events.length - this.capacity);
		}
		this.deliver(published, () => true);
		return published;
	}

	private notifyEdited(path: string, marks: number): void {
		const edited: ReviewEvent = {
			seq: this.seq,
			time: this.now().toISOString(),
			type: "edited",
			path,
			added: [],
			removed: [],
			marks,
		};
		this.deliver(edited, (waiter) => waiter.request.anyChange);
	}

	private deliver(event: ReviewEvent, accepts: (waiter: Waiter) => boolean): void {
		const remaining: Waiter[] = [];
		for (const waiter of this.waiters) {
			const passed =
				accepts(waiter) && inScope(waiter.request.scope, event)
					? filterEvent(event, waiter.request.filter)
					: null;
			if (!passed) {
				remaining.push(waiter);
				continue;
			}
			if (waiter.timer !== null) this.timers.clearTimeout(waiter.timer);
			waiter.resolve({ cursor: event.seq, events: [passed], timedOut: false, gap: false });
		}
		this.waiters = remaining;
	}
}

/** A rename counts for a scope that holds either end of the move. */
function inScope(scope: string | null, event: ReviewEvent): boolean {
	return (
		scopeContains(scope, event.path) ||
		(event.from !== undefined && scopeContains(scope, event.from))
	);
}

function diff(
	left: Map<string, ReviewMarkSummary>,
	right: Map<string, ReviewMarkSummary>,
): ReviewMarkSummary[] {
	const out: ReviewMarkSummary[] = [];
	for (const [key, summary] of left) {
		if (!right.has(key)) out.push(summary);
	}
	return out;
}
