/**
 * Canvas comment threads, Figma-style: each pin is one thread, stored on
 * the canvas node it belongs to under a `relayComments` field. Obsidian
 * preserves unknown node fields across save cycles, and Relay stores
 * whole node objects in its CRDT, so this field syncs without any Relay
 * changes. Freestanding pins live on invisible zero-size carrier nodes
 * marked `relayCommentCarrier`.
 */

export interface CanvasComment {
	author: string;
	authorId?: string;
	date: string;
	text: string;
}

export interface CanvasCommentThread {
	id: string;
	/** Pin offset from the node's top-left corner, in canvas units. */
	dx: number;
	dy: number;
	resolved?: boolean;
	comments: CanvasComment[];
}

/** The subset of canvas node data this module reads and writes. */
export interface CommentableNodeData {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	relayComments?: CanvasCommentThread[];
	relayCommentCarrier?: boolean;
	[key: string]: unknown;
}

export function threadsOf(node: CommentableNodeData): CanvasCommentThread[] {
	return Array.isArray(node.relayComments) ? node.relayComments : [];
}

export function newThreadId(): string {
	return `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createThread(
	node: CommentableNodeData,
	thread: CanvasCommentThread,
): CommentableNodeData {
	return { ...node, relayComments: [...threadsOf(node), thread] };
}

export function addReply(
	node: CommentableNodeData,
	threadId: string,
	comment: CanvasComment,
): CommentableNodeData {
	return {
		...node,
		relayComments: threadsOf(node).map((thread) =>
			thread.id === threadId
				? { ...thread, comments: [...thread.comments, comment] }
				: thread,
		),
	};
}

export function setThreadResolved(
	node: CommentableNodeData,
	threadId: string,
	resolved: boolean,
): CommentableNodeData {
	return {
		...node,
		relayComments: threadsOf(node).map((thread) =>
			thread.id === threadId ? { ...thread, resolved } : thread,
		),
	};
}

export function removeThread(
	node: CommentableNodeData,
	threadId: string,
): CommentableNodeData {
	const remaining = threadsOf(node).filter((thread) => thread.id !== threadId);
	if (remaining.length === 0) {
		const { relayComments: _dropped, ...rest } = node;
		return rest;
	}
	return { ...node, relayComments: remaining };
}

/** A carrier with no threads left has no reason to exist. */
export function isEmptyCarrier(node: CommentableNodeData): boolean {
	return node.relayCommentCarrier === true && threadsOf(node).length === 0;
}

export function makeCarrierNode(
	id: string,
	x: number,
	y: number,
): CommentableNodeData {
	return {
		id,
		type: "text",
		text: "",
		x,
		y,
		width: 0,
		height: 0,
		relayCommentCarrier: true,
	};
}

/** Pin position in canvas coordinates. */
export function pinPosition(
	node: CommentableNodeData,
	thread: CanvasCommentThread,
): { x: number; y: number } {
	return { x: node.x + thread.dx, y: node.y + thread.dy };
}

/**
 * Convert a screen point to canvas coordinates given the canvas
 * transform (translate tx/ty applied after scaling by zoom).
 */
export function screenToCanvas(
	screenX: number,
	screenY: number,
	tx: number,
	ty: number,
	zoom: number,
): { x: number; y: number } {
	return { x: (screenX - tx) / zoom, y: (screenY - ty) / zoom };
}

export function formatCommentDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

/** Initial shown inside a pin, like a letter avatar. */
export function pinInitial(thread: CanvasCommentThread): string {
	const author = thread.comments[0]?.author?.trim() ?? "";
	return author ? author[0].toUpperCase() : "?";
}

/** Two-letter initials, same rule as the sidebar's avatars. */
export function authorInitials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	return words
		.slice(0, 2)
		.map((word) => word[0]?.toUpperCase() ?? "")
		.join("");
}
