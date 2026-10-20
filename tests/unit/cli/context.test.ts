import { buildCliContext } from "src/cli/context";
import type RelayCommentsPlugin from "src/main";
import type { ReviewEventLog } from "src/cli/events";
import type { CanvasDoc } from "src/cli/canvas";

jest.mock("obsidian", () => ({
	TFile: class {},
	TFolder: class {},
	normalizePath: (path: string) => path,
}), { virtual: true });

const clone = (value: CanvasDoc): CanvasDoc => JSON.parse(JSON.stringify(value));

function board(comments: string[]): CanvasDoc {
	return {
		nodes: [{
			id: "card", type: "text", text: "Review", x: 0, y: 0, width: 300, height: 200,
			relayComments: [{
				id: "thread", dx: 300, dy: 0,
				comments: comments.map(text => ({ text, author: "Reviewer", date: "2026-10-01" })),
			}],
		}],
		edges: [],
	};
}

function fixture(withPendingHook = true) {
	let current = board(["User opens the pin."]);
	const history = { data: [clone(current)], index: 0 };
	let pending: CanvasDoc | undefined;
	const flush = () => {
		if (!pending) return;
		history.data.splice(history.index + 1);
		history.data.push(pending);
		history.index += 1;
		pending = undefined;
	};
	const live = {
		getData: () => current,
		importData: (next: CanvasDoc) => { current = clone(next); },
		requestSave: jest.fn((pushHistory = true) => {
			if (pushHistory) pending = clone(current);
		}),
		history,
		...(withPendingHook ? { requestPushHistory: { run: jest.fn(flush) } } : {}),
	};
	const plugin = {
		app: { workspace: {
			iterateAllLeaves: (visit: (leaf: unknown) => void) => visit({
				view: { getViewType: () => "canvas", file: { path: "Review.canvas" }, canvas: live },
			}),
		} },
	} as unknown as RelayCommentsPlugin;
	return {
		ctx: buildCliContext(plugin, {} as ReviewEventLog),
		live, history, flush,
		pending: () => pending,
		undo: () => { current = clone(history.data[--history.index]); },
		redo: () => { current = clone(history.data[++history.index]); },
		texts: () => current.nodes[0].relayComments![0].comments.map(comment => comment.text),
	};
}

test("a foreign canvas edit rebases a pending user history snapshot before redo", async () => {
	const f = fixture();
	await f.ctx.notes.editCanvas("Review.canvas", () => board(["User opens the pin.", "User replies."]));
	expect(f.pending()).toBeDefined();
	await f.ctx.notes.editCanvas("Review.canvas",
		() => board(["User opens the pin.", "User replies.", "Agent reply."]), { asUser: false });
	// Simulate the queued history timer firing after the CLI returns.
	f.flush();
	expect(f.history.data).toHaveLength(2);
	f.undo();
	expect(f.texts()).toEqual(["User opens the pin.", "Agent reply."]);
	f.redo();
	expect(f.texts()).toEqual(["User opens the pin.", "User replies.", "Agent reply."]);
	expect(f.pending()).toBeUndefined();
	expect(f.live.requestSave).toHaveBeenLastCalledWith(false);
});

test("user canvas edits keep their normal deferred undo step", async () => {
	const f = fixture();
	await f.ctx.notes.editCanvas("Review.canvas", () => board(["User opens the pin.", "User replies."]));
	expect(f.live.requestPushHistory?.run).not.toHaveBeenCalled();
	expect(f.pending()).toBeDefined();
	f.flush();
	f.undo();
	expect(f.texts()).toEqual(["User opens the pin."]);
});

test("canvas histories without a pending-history hook still rebase foreign edits", async () => {
	const f = fixture(false);
	await f.ctx.notes.editCanvas("Review.canvas",
		() => board(["User opens the pin.", "Agent reply."]), { asUser: false });
	expect(f.history.data).toHaveLength(1);
	expect(f.history.data[0].nodes[0].relayComments![0].comments.map(c => c.text))
		.toEqual(["User opens the pin.", "Agent reply."]);
});
