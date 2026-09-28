import {
	addReply,
	createThread,
	newThreadId,
	setThreadResolved,
	threadsOf,
	type CanvasComment,
	type CommentableNodeData,
} from "../canvas/comments-data";
import { locateQuote, projectThreads, type NoteThreads, type ThreadInfo } from "./threads";
import { CliError } from "./types";

/**
 * Canvas documents for the CLI: parse and serialize the JSON, list the
 * review threads on a canvas, and pick the text card a passage lives in.
 *
 * A canvas carries two kinds of thread. Comment pins are stored on nodes
 * under `relayComments`, exactly as the pin UI writes them. Text cards
 * hold ordinary CriticMarkup in their `text`, the same as a note. Both are
 * listed together, node by node in file order, with one running index.
 * Text-card threads carry offsets within their card and an id of the form
 * `<node>:<mark id>`; pin threads carry the pin's own id.
 *
 * Pure TypeScript: no Obsidian imports.
 */

export interface CanvasDoc {
	nodes: CanvasNode[];
	[key: string]: unknown;
}

export type CanvasNode = CommentableNodeData & { type?: unknown; text?: unknown };

export function isCanvasPath(path: string): boolean {
	return path.toLowerCase().endsWith(".canvas");
}

export function parseCanvas(text: string): CanvasDoc {
	let data: unknown;
	try {
		data = JSON.parse(text.trim() === "" ? "{}" : text);
	} catch {
		throw new CliError("invalid_canvas", "The canvas file is not valid JSON");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new CliError("invalid_canvas", "The canvas file is not a canvas document");
	}
	const doc = data as Record<string, unknown>;
	const nodes = Array.isArray(doc.nodes)
		? (doc.nodes.filter((node) => node && typeof node === "object") as CanvasNode[])
		: [];
	return { ...doc, nodes };
}

/** Obsidian writes canvases as tab-indented JSON. */
export function serializeCanvas(doc: CanvasDoc): string {
	return JSON.stringify(doc, null, "\t");
}

function nodeText(node: CanvasNode): string | null {
	return node.type === "text" && typeof node.text === "string" ? node.text : null;
}

function nodeId(node: CanvasNode): string {
	return typeof node.id === "string" ? node.id : "";
}

export function projectCanvasThreads(doc: CanvasDoc): NoteThreads {
	const threads: ThreadInfo[] = [];
	const invalid: NoteThreads["invalid"] = [];
	for (const node of doc.nodes) {
		const id = nodeId(node);
		const text = nodeText(node);
		if (text !== null) {
			const card = projectThreads(text);
			for (const thread of card.threads) {
				threads.push({ ...thread, id: `${id}:${thread.id}`, node: id, index: 0 });
			}
			for (const mark of card.invalid) invalid.push({ ...mark, node: id });
		}
		for (const pin of threadsOf(node)) {
			// A pin with no comments is a draft the pin UI saved while its
			// composer is open; it is not a thread yet.
			if (!Array.isArray(pin.comments) || pin.comments.length === 0) continue;
			threads.push({
				index: 0,
				id: pin.id,
				kind: "pin",
				node: id,
				from: 0,
				to: 0,
				anchorFrom: 0,
				anchorTo: 0,
				text: "",
				resolved: pin.resolved === true,
				comments: (Array.isArray(pin.comments) ? pin.comments : []).map((comment) => ({
					text: typeof comment.text === "string" ? comment.text : "",
					...(comment.author ? { author: comment.author } : {}),
					...(comment.authorId ? { authorId: comment.authorId } : {}),
					...(comment.date ? { date: comment.date } : {}),
				})),
			});
		}
	}
	threads.forEach((thread, i) => {
		thread.index = i + 1;
	});
	return { threads, invalid };
}

export function findNode(doc: CanvasDoc, id: string): CanvasNode {
	const node = doc.nodes.find((candidate) => nodeId(candidate) === id);
	if (!node) {
		throw new CliError("node_not_found", `No node ${id} on this canvas`, {
			candidates: doc.nodes.map(nodeId),
		});
	}
	return node;
}

export function replaceNode(doc: CanvasDoc, id: string, next: CanvasNode): CanvasDoc {
	return { ...doc, nodes: doc.nodes.map((node) => (nodeId(node) === id ? next : node)) };
}

/** The text of a card by node id, refusing nodes that are not text cards. */
export function cardText(doc: CanvasDoc, id: string): string {
	const text = nodeText(findNode(doc, id));
	if (text === null) {
		throw new CliError("not_a_text_card", `Node ${id} is not a text card`);
	}
	return text;
}

/**
 * The single text card holding a quote, optionally limited to one node.
 * `line` is the 1-based line within the card.
 */
export function cardForQuote(
	doc: CanvasDoc,
	quote: string,
	node?: string,
	line?: number,
): { node: string; range: { from: number; to: number } } {
	const candidates = node === undefined ? doc.nodes : [findNode(doc, node)];
	const hits: Array<{ node: string; range: { from: number; to: number } }> = [];
	for (const candidate of candidates) {
		const text = nodeText(candidate);
		if (text === null || !text.includes(quote)) continue;
		try {
			hits.push({ node: nodeId(candidate), range: locateQuote(text, quote, line) });
		} catch (error) {
			if (node !== undefined) throw error;
			if (error instanceof CliError && error.code === "ambiguous_quote") {
				throw new CliError(
					"ambiguous_quote",
					`The quoted text occurs more than once in node ${nodeId(candidate)}; add line=<n>`,
					error.extra,
				);
			}
		}
	}
	if (hits.length === 0) {
		throw new CliError(
			"quote_not_found",
			node === undefined
				? "The quoted text does not occur in any text card on this canvas"
				: `The quoted text does not occur in node ${node}`,
		);
	}
	if (hits.length > 1) {
		throw new CliError(
			"ambiguous_quote",
			"The quoted text occurs in more than one text card; add node=<id>",
			{ candidates: hits.map((hit) => hit.node) },
		);
	}
	return hits[0];
}

/** A card thread with its id as the card's own parser gave it. */
export function cardThread(thread: ThreadInfo): ThreadInfo {
	if (thread.node === undefined || !thread.id.startsWith(`${thread.node}:`)) return thread;
	return { ...thread, id: thread.id.slice(thread.node.length + 1) };
}

/** Open a pin on a node at the standard top-right anchor, as the pin UI does. */
export function openPin(
	doc: CanvasDoc,
	id: string,
	comment: CanvasComment,
): { doc: CanvasDoc; thread: string } {
	const node = findNode(doc, id);
	const thread = newThreadId();
	const next = createThread(node, {
		id: thread,
		dx: typeof node.width === "number" ? node.width : 0,
		dy: 0,
		comments: [comment],
	}) as CanvasNode;
	return { doc: replaceNode(doc, id, next), thread };
}

export function replyToPin(
	doc: CanvasDoc,
	thread: ThreadInfo,
	comment: CanvasComment,
): CanvasDoc {
	const id = thread.node ?? "";
	return replaceNode(doc, id, addReply(findNode(doc, id), thread.id, comment));
}

export function resolvePin(doc: CanvasDoc, thread: ThreadInfo): CanvasDoc {
	if (thread.resolved) {
		throw new CliError("already_resolved", `Thread ${thread.index} is already resolved`);
	}
	const id = thread.node ?? "";
	return replaceNode(doc, id, setThreadResolved(findNode(doc, id), thread.id, true));
}

interface ThreadRecord {
	id?: unknown;
	resolved?: unknown;
	comments?: unknown;
	[key: string]: unknown;
}

function threadList(node: CanvasNode | undefined): ThreadRecord[] {
	return Array.isArray(node?.relayComments) ? (node.relayComments as unknown as ThreadRecord[]) : [];
}

function commentList(thread: ThreadRecord | undefined): unknown[] {
	return Array.isArray(thread?.comments) ? thread.comments : [];
}

/**
 * Replay one edit, given as the canvas before and after it, onto an older
 * snapshot from the canvas's undo history. Canvas undo restores whole
 * snapshots, so an edit that must not be undone (one made as someone other
 * than the user) has to be present in every snapshot the user can step
 * back to. Pins replay as operations: a new thread is added, appended
 * comments are appended, and a changed resolved flag is set, wherever the
 * node and thread exist. A text card replays only onto the text it was
 * made against; an older text is left as it was.
 */
export function rebaseCanvasSnapshot(
	snapshot: CanvasDoc,
	before: CanvasDoc,
	after: CanvasDoc,
): CanvasDoc {
	const beforeNodes = new Map(before.nodes.map((node) => [nodeId(node), node]));
	let nodes = snapshot.nodes;
	for (const next of after.nodes) {
		const id = nodeId(next);
		const prior = beforeNodes.get(id);
		const index = nodes.findIndex((node) => nodeId(node) === id);
		if (!prior || index === -1) continue;
		let target: CanvasNode = nodes[index];
		let changed = false;
		if (next.text !== prior.text && target.text === prior.text) {
			target = { ...target, text: next.text };
			changed = true;
		}
		const priorThreads = new Map(threadList(prior).map((thread) => [thread.id, thread]));
		let threads = threadList(target);
		for (const thread of threadList(next)) {
			const was = priorThreads.get(thread.id);
			const at = threads.findIndex((candidate) => candidate.id === thread.id);
			if (!was) {
				if (at === -1) {
					threads = [...threads, thread];
					changed = true;
				}
				continue;
			}
			if (at === -1) continue;
			let current = threads[at];
			const appended = commentList(thread).slice(commentList(was).length);
			if (appended.length > 0) {
				current = { ...current, comments: [...commentList(current), ...appended] };
			}
			if (thread.resolved !== was.resolved) {
				current = { ...current, resolved: thread.resolved };
			}
			if (current !== threads[at]) {
				threads = threads.map((candidate, i) => (i === at ? current : candidate));
				changed = true;
			}
		}
		if (threads !== threadList(target)) {
			target = { ...target, relayComments: threads } as unknown as CanvasNode;
		}
		if (changed) nodes = nodes.map((node, i) => (i === index ? target : node));
	}
	return nodes === snapshot.nodes ? snapshot : { ...snapshot, nodes };
}
