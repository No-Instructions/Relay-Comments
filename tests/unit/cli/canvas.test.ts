import { describe, expect, it } from "@jest/globals";
import type { CliData } from "obsidian";
import {
	cardForQuote,
	parseCanvas,
	projectCanvasThreads,
	rebaseCanvasSnapshot,
	serializeCanvas,
	type CanvasDoc,
} from "src/cli/canvas";
import { CLI_COMMANDS } from "src/cli/commands";
import { cliHandler } from "src/cli/registerCli";
import { CliError } from "src/cli/types";
import { fakeVault, type FakeVault } from "./support";

const STAMP = "2026-09-26T12:00:00.000Z";
const BOARD = "Boards/plan.canvas";

function board(): CanvasDoc {
	return {
		nodes: [
			{
				id: "card",
				type: "text",
				text: "First card needs a source.\n{==Old claim==}{{author=\"Bongo Cat\">>Still true?<<}}",
				x: 0,
				y: 0,
				width: 300,
				height: 120,
			},
			{
				id: "second",
				type: "text",
				text: "Second card with {~~teh~>the~~} typo.",
				x: 400,
				y: 0,
				width: 250,
				height: 80,
				relayComments: [
					{
						id: "cc-1",
						dx: 250,
						dy: 0,
						comments: [{ author: "Bongo Cat", authorId: "u1", date: "2026-09-25T10:00:00.000Z", text: "Move this?" }],
					},
				],
			},
			{ id: "file", type: "file", file: "Notes/plan.md", x: 0, y: 300, width: 300, height: 200 },
		],
		edges: [],
	};
}

function vault(): FakeVault {
	return fakeVault({ [BOARD]: serializeCanvas(board()), "Boards/readme.md": "{>>note<<}\n" });
}

async function json(target: FakeVault, id: string, params: CliData): Promise<Record<string, unknown>> {
	const command = CLI_COMMANDS.find((candidate) => candidate.id === id);
	if (!command) throw new Error(`no command ${id}`);
	return JSON.parse(await cliHandler(command, target.ctx)({ ...params, format: "json" })) as Record<string, unknown>;
}

async function text(target: FakeVault, id: string, params: CliData): Promise<string> {
	const command = CLI_COMMANDS.find((candidate) => candidate.id === id);
	if (!command) throw new Error(`no command ${id}`);
	return cliHandler(command, target.ctx)(params);
}

function saved(target: FakeVault): CanvasDoc {
	return parseCanvas(target.notes.get(BOARD) ?? "");
}

function node(target: FakeVault, id: string): Record<string, unknown> {
	return saved(target).nodes.find((candidate) => candidate.id === id) as Record<string, unknown>;
}

describe("projectCanvasThreads", () => {
	it("lists text-card threads and pins node by node with one running index", () => {
		const { threads } = projectCanvasThreads(board());
		expect(threads.map((thread) => [thread.index, thread.kind, thread.node, thread.line])).toEqual([
			[1, "highlight", "card", 2],
			[2, "substitution", "second", 1],
			[3, "pin", "second", undefined],
		]);
		expect(threads[0].id).toMatch(/^card:highlight:/);
		expect(threads[2]).toMatchObject({
			id: "cc-1",
			resolved: false,
			comments: [{ author: "Bongo Cat", authorId: "u1", text: "Move this?" }],
		});
	});

	it("leaves out a draft pin with no comments", () => {
		const doc = board();
		doc.nodes[0].relayComments = [{ id: "cc-draft", dx: 0, dy: 0, comments: [] }];
		expect(projectCanvasThreads(doc).threads.map((thread) => thread.id)).not.toContain("cc-draft");
	});

	it("rejects a file that is not canvas JSON", () => {
		expect(() => parseCanvas("{nodes")).toThrow(CliError);
		expect(parseCanvas("").nodes).toEqual([]);
	});
});

describe("cardForQuote", () => {
	it("finds the one card that holds a quote, or asks for a node", () => {
		expect(cardForQuote(board(), "needs a source")).toEqual({
			node: "card",
			range: { from: 11, to: 25 },
		});
		expect(() => cardForQuote(board(), "card")).toThrow(/more than one text card; add node=<id>/);
		expect(cardForQuote(board(), "card", "second").node).toBe("second");
		expect(() => cardForQuote(board(), "nowhere")).toThrow(/does not occur in any text card/);
		expect(() => cardForQuote(board(), "x", "missing")).toThrow(/No node missing/);
	});
});

describe("canvas commands", () => {
	it("lists canvas threads, alone and in a folder scan", async () => {
		const target = vault();
		const listed = await text(target, "comments:threads", { path: "Boards/plan" });
		expect(listed).toContain("Boards/plan.canvas: 3 threads");
		expect(listed).toContain('1. highlight node card L2 "Old claim"');
		expect(listed).toContain("3. pin node second");
		expect(listed).toContain("   Bongo Cat · 2026-09-25: Move this?");
		const folder = await json(target, "comments:threads", { path: "Boards" });
		expect((folder.notes as Array<{ path: string }>).map((note) => note.path)).toEqual([
			BOARD,
			"Boards/readme.md",
		]);
	});

	it("pins a comment to a node at its top-right corner, signed like the pin UI", async () => {
		const target = vault();
		const result = await json(target, "comments:comment", { path: BOARD, node: "card", text: "Cite this." });
		const pins = node(target, "card").relayComments as Array<Record<string, unknown>>;
		expect(pins).toHaveLength(1);
		expect(pins[0]).toMatchObject({
			dx: 300,
			dy: 0,
			comments: [{ author: "Claude", authorId: "mqvxlopr0ocsmgv", date: STAMP, text: "Cite this." }],
		});
		expect(pins[0].id).toMatch(/^cc-/);
		expect(result).toMatchObject({
			ok: true,
			signedAs: "Claude",
			thread: { kind: "pin", node: "card", id: pins[0].id, index: 2 },
		});
	});

	it("comments on a passage in a text card with CriticMarkup", async () => {
		const target = vault();
		const result = await json(target, "comments:comment", {
			path: BOARD,
			quote: "needs a source",
			text: "Which one?",
		});
		expect(node(target, "card").text).toBe(
			`First card {==needs a source==}{{authorId="mqvxlopr0ocsmgv" author="Claude" date="${STAMP}">>Which one?<<}}.\n{==Old claim==}{{author="Bongo Cat">>Still true?<<}}`,
		);
		expect(result).toMatchObject({ thread: { kind: "highlight", node: "card", line: 1, text: "needs a source" } });
	});

	it("requires a node or a quote on a canvas and refuses non-text nodes", async () => {
		const target = vault();
		expect(await json(target, "comments:comment", { path: BOARD, text: "x" })).toMatchObject({
			ok: false,
			code: "missing_flag",
		});
		expect(
			await json(target, "comments:comment", { path: BOARD, node: "nope", text: "x" }),
		).toMatchObject({ ok: false, code: "node_not_found", candidates: ["card", "second", "file"] });
		expect(
			await json(target, "comments:suggest", { path: BOARD, node: "file", quote: "x", insert: "y" }),
		).toMatchObject({ ok: false, code: "quote_not_found" });
	});

	it("replies to a pin and to a text-card thread", async () => {
		const target = vault();
		const pinned = await json(target, "comments:reply", { path: BOARD, thread: "3", text: "Done.", author: "Guest" });
		const pin = (node(target, "second").relayComments as Array<{ comments: unknown[] }>)[0];
		expect(pin.comments).toEqual([
			expect.objectContaining({ text: "Move this?" }),
			{ author: "Guest", date: STAMP, text: "Done." },
		]);
		expect(pinned).toMatchObject({ thread: { kind: "pin", comments: [{}, { author: "Guest" }] } });
		await json(target, "comments:reply", { path: BOARD, thread: "1", text: "Yes." });
		expect(node(target, "card").text).toContain(
			`{{author="Bongo Cat">>Still true?<<}}{{authorId="mqvxlopr0ocsmgv" author="Claude" date="${STAMP}">>Yes.<<}}`,
		);
	});

	it("resolves a pin by marking it resolved, and a text-card thread by removing it", async () => {
		const target = vault();
		const result = await json(target, "comments:resolve", { path: BOARD, thread: "3" });
		expect((node(target, "second").relayComments as Array<{ resolved: boolean }>)[0].resolved).toBe(true);
		expect(result).toMatchObject({ ok: true, thread: { kind: "pin", resolved: true } });
		expect(await json(target, "comments:resolve", { path: BOARD, thread: "3" })).toMatchObject({
			ok: false,
			code: "already_resolved",
		});
		await json(target, "comments:resolve", { path: BOARD, thread: "1" });
		expect(node(target, "card").text).toBe("First card needs a source.\nOld claim");
	});

	it("accepts and rejects suggestions in text cards and refuses pins", async () => {
		const accepted = vault();
		await json(accepted, "comments:accept", { path: BOARD, thread: "2" });
		expect(node(accepted, "second").text).toBe("Second card with the typo.");
		const rejected = vault();
		await json(rejected, "comments:reject", { path: BOARD, thread: "2" });
		expect(node(rejected, "second").text).toBe("Second card with teh typo.");
		expect(await json(rejected, "comments:accept", { path: BOARD, thread: "2" })).toMatchObject({
			ok: false,
			code: "not_a_suggestion",
			message: "Thread 2 is a comment pin; use comments:resolve",
		});
	});

	it("suggests an edit in a text card and keeps other node fields", async () => {
		const target = vault();
		const result = await json(target, "comments:suggest", {
			path: BOARD,
			node: "card",
			quote: "First card",
			replace: "Opening card",
		});
		expect(node(target, "card")).toMatchObject({
			x: 0,
			width: 300,
			text: expect.stringMatching(/^\{~~First card~>Opening card~~\} needs a source\./),
		});
		expect(result).toMatchObject({ thread: { kind: "substitution", node: "card", index: 1 } });
		expect(saved(target).edges).toEqual([]);
	});
});

describe("rebaseCanvasSnapshot", () => {
	const at = (doc: CanvasDoc, id: string) => doc.nodes.find((node) => node.id === id) as Record<string, unknown>;
	const pins = (doc: CanvasDoc, id: string) => (at(doc, id).relayComments ?? []) as Array<{ id: string; resolved?: boolean; comments: Array<{ text: string }> }>;

	it("adds a new pin, appends comments, and sets resolution in an older snapshot", () => {
		const before = board();
		let after = board();
		after = {
			...after,
			nodes: after.nodes.map((node) =>
				node.id === "second"
					? { ...node, relayComments: [{ ...(node.relayComments ?? [])[0], resolved: true, comments: [...((node.relayComments ?? [])[0].comments), { author: "Claude", date: "d", text: "agent" }] }] }
					: node.id === "card"
						? { ...node, relayComments: [{ id: "cc-new", dx: 300, dy: 0, comments: [{ author: "Claude", date: "d", text: "new pin" }] }] }
						: node,
			),
		};
		const older = board();
		// The user's own earlier state: the card text differs, the pin thread is the same.
		older.nodes[0] = { ...older.nodes[0], text: "An older text", x: 50 };
		const rebased = rebaseCanvasSnapshot(older, before, after);
		expect(pins(rebased, "second")[0]).toMatchObject({ resolved: true });
		expect(pins(rebased, "second")[0].comments.map((c) => c.text)).toEqual(["Move this?", "agent"]);
		expect(pins(rebased, "card").map((pin) => pin.id)).toEqual(["cc-new"]);
		expect(at(rebased, "card")).toMatchObject({ text: "An older text", x: 50 });
	});

	it("replays a text-card edit only onto the text it was made against", () => {
		const before = board();
		const after = { ...board(), nodes: board().nodes.map((node) => (node.id === "second" ? { ...node, text: "Second card with the typo." } : node)) };
		expect(at(rebaseCanvasSnapshot(board(), before, after), "second").text).toBe("Second card with the typo.");
		const edited = board();
		edited.nodes[1] = { ...edited.nodes[1], text: "User rewrote this card." };
		expect(at(rebaseCanvasSnapshot(edited, before, after), "second").text).toBe("User rewrote this card.");
	});

	it("skips nodes and threads the snapshot does not have and never duplicates", () => {
		const before = board();
		const after = { ...board(), nodes: board().nodes.map((node) => (node.id === "second" ? { ...node, relayComments: [...(node.relayComments ?? []), { id: "cc-2", dx: 0, dy: 0, comments: [{ author: "Claude", date: "d", text: "x" }] }] } : node)) };
		const withoutNode = { ...board(), nodes: board().nodes.filter((node) => node.id !== "second") };
		expect(rebaseCanvasSnapshot(withoutNode, before, after)).toBe(withoutNode);
		const once = rebaseCanvasSnapshot(board(), before, after);
		expect(pins(rebaseCanvasSnapshot(once, before, after), "second").map((pin) => pin.id)).toEqual(["cc-1", "cc-2"]);
	});
});
