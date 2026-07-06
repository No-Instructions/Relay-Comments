import { describe, expect, it } from "@jest/globals";
import {
	addReply,
	authorInitials,
	createThread,
	isEmptyCarrier,
	makeCarrierNode,
	nodeAtPoint,
	pinInitial,
	pinPosition,
	removeThread,
	screenToCanvas,
	setThreadResolved,
	threadsOf,
} from "src/canvas/comments-data";
import type {
	CanvasCommentThread,
	CommentableNodeData,
} from "src/canvas/comments-data";

const node = (extra: Partial<CommentableNodeData> = {}): CommentableNodeData => ({
	id: "n1",
	x: 100,
	y: 200,
	width: 250,
	height: 60,
	...extra,
});

const thread = (
	extra: Partial<CanvasCommentThread> = {},
): CanvasCommentThread => ({
	id: "t1",
	dx: 250,
	dy: 0,
	comments: [{ author: "Matt", date: "2026-07-06T10:00:00Z", text: "hi" }],
	...extra,
});

describe("canvas comment threads", () => {
	it("creates a thread without mutating the node", () => {
		const original = node();
		const next = createThread(original, thread());
		expect(threadsOf(next)).toHaveLength(1);
		expect(original.relayComments).toBeUndefined();
	});

	it("appends replies to the right thread only", () => {
		const withTwo = createThread(
			createThread(node(), thread()),
			thread({ id: "t2" }),
		);
		const next = addReply(withTwo, "t2", {
			author: "Daniel",
			date: "2026-07-06T11:00:00Z",
			text: "yep",
		});
		expect(threadsOf(next)[0].comments).toHaveLength(1);
		expect(threadsOf(next)[1].comments).toHaveLength(2);
	});

	it("resolves and unresolves a thread", () => {
		const withOne = createThread(node(), thread());
		const resolved = setThreadResolved(withOne, "t1", true);
		expect(threadsOf(resolved)[0].resolved).toBe(true);
		expect(threadsOf(setThreadResolved(resolved, "t1", false))[0].resolved).toBe(
			false,
		);
	});

	it("drops the relayComments field when the last thread is removed", () => {
		const withOne = createThread(node(), thread());
		const next = removeThread(withOne, "t1");
		expect(next.relayComments).toBeUndefined();
	});

	it("identifies empty carriers for cleanup", () => {
		const carrier = makeCarrierNode("c1", 10, 20);
		expect(isEmptyCarrier(carrier)).toBe(true);
		expect(isEmptyCarrier(createThread(carrier, thread()))).toBe(false);
		expect(isEmptyCarrier(node())).toBe(false);
	});

	it("makes invisible zero-size carriers", () => {
		const carrier = makeCarrierNode("c1", 10, 20);
		expect(carrier.width).toBe(0);
		expect(carrier.height).toBe(0);
		expect(carrier.type).toBe("text");
	});

	it("computes pin positions from node position plus offset", () => {
		expect(pinPosition(node(), thread())).toEqual({ x: 350, y: 200 });
	});

	it("inverts the canvas transform for placement clicks", () => {
		// zoom 2, translated by (50, -30): canvas (100, 200) renders at
		// screen (250, 370); the inverse must recover the canvas point.
		expect(screenToCanvas(250, 370, 50, -30, 2)).toEqual({ x: 100, y: 200 });
	});

	it("uses the first author's initial for the pin", () => {
		expect(pinInitial(thread())).toBe("M");
		expect(pinInitial(thread({ comments: [] }))).toBe("?");
	});

	it("builds two-letter avatar initials like the sidebar", () => {
		expect(authorInitials("Daniel Kavanagh")).toBe("DK");
		expect(authorInitials("Matt")).toBe("M");
		expect(authorInitials("  ")).toBe("?");
	});

	it("attaches points over a node to that node, topmost first", () => {
		const below = node({ id: "below" });
		const above = node({ id: "above" });
		const carrier = { ...makeCarrierNode("c1", 110, 210), width: 0, height: 0 };
		expect(nodeAtPoint([below, above, carrier], { x: 120, y: 220 })?.id).toBe(
			"above",
		);
		expect(nodeAtPoint([below], { x: 90, y: 220 })).toBeNull();
		expect(nodeAtPoint([carrier], { x: 110, y: 210 })).toBeNull();
	});
});
