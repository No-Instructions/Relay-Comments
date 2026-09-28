import { describe, expect, it } from "@jest/globals";
import {
	ReviewEventLog,
	canvasMarkKeys,
	filterEvent,
	markKeys,
	scopeContains,
	type ReviewEvent,
} from "src/cli/events";
import { parseCriticMarkup } from "src/critic/parse";
import { fakeTimers } from "./support";

const NOTE = "Notes/plan.md";
const CLEAN = "Alpha paragraph.\nBeta paragraph.\n";
const WITH_COMMENT =
	'Alpha paragraph.\n{==Beta==}{{author="Bongo Cat" date="2026-09-26T10:00:00.000Z">>Why beta?<<}} paragraph.\n';

function log(options: { capacity?: number } = {}) {
	const clock = fakeTimers();
	return {
		clock,
		events: new ReviewEventLog({
			timers: clock.timers,
			now: () => new Date("2026-09-26T12:00:00.000Z"),
			...options,
		}),
	};
}

describe("scopeContains", () => {
	it("treats null or empty as the whole vault and folders as prefixes", () => {
		expect(scopeContains(null, "a/b.md")).toBe(true);
		expect(scopeContains("", "a/b.md")).toBe(true);
		expect(scopeContains("a", "a/b.md")).toBe(true);
		expect(scopeContains("a/b.md", "a/b.md")).toBe(true);
		expect(scopeContains("a/b", "a/bc.md")).toBe(false);
	});
});

describe("markKeys", () => {
	it("identifies a mark by kind and source, not position, and keeps duplicates apart", () => {
		const text = "{>>same<<} x {>>same<<} {++add++}";
		const keys = markKeys(parseCriticMarkup(text), 400);
		expect(keys.size).toBe(3);
		const shifted = markKeys(parseCriticMarkup(`prefix ${text}`), 400);
		expect([...shifted.keys()]).toEqual([...keys.keys()]);
	});

	it("summarizes marks with 1-based lines, readable text, and metadata", () => {
		const summaries = [...markKeys(parseCriticMarkup(WITH_COMMENT), 400).values()];
		expect(summaries[0]).toMatchObject({ kind: "highlight", line: 2, text: "Beta" });
		expect(summaries[1]).toMatchObject({
			kind: "comment",
			line: 2,
			text: "Why beta?",
			author: "Bongo Cat",
			date: "2026-09-26T10:00:00.000Z",
		});
	});

	it("renders a substitution as old → new and truncates raw source", () => {
		const [summary] = [...markKeys(parseCriticMarkup("{~~old~>new~~}"), 5).values()];
		expect(summary.text).toBe("old → new");
		expect(summary.raw).toBe("{~~ol…");
	});
});

describe("filterEvent", () => {
	const event: ReviewEvent = {
		seq: 1,
		time: "t",
		type: "changed",
		path: NOTE,
		added: [
			{ kind: "highlight", line: 1, text: "Beta", raw: "{==Beta==}" },
			{ kind: "comment", line: 1, text: "mine", raw: "", author: "Claude", authorId: "cid" },
		],
		removed: [],
		marks: 2,
	};

	it("passes everything without a filter", () => {
		expect(filterEvent(event)).toBe(event);
	});

	it("drops an event whose signed marks are all by ignored authors, by name or id", () => {
		expect(filterEvent(event, { ignoreAuthors: new Set(["Claude"]) })).toBeNull();
		expect(filterEvent(event, { ignoreAuthors: new Set(["cid"]) })).toBeNull();
		const mixed = {
			...event,
			added: [...event.added, { kind: "comment" as const, line: 2, text: "theirs", raw: "", author: "Bongo" }],
		};
		expect(
			filterEvent(mixed, { ignoreAuthors: new Set(["Claude"]) })?.added.map((mark) => mark.text),
		).toEqual(["Beta", "theirs"]);
	});

	it("keeps only named kinds and drops mark-less events when kinds are named", () => {
		expect(
			filterEvent(event, { kinds: new Set(["comment"]) })?.added.map((mark) => mark.kind),
		).toEqual(["comment"]);
		expect(filterEvent(event, { kinds: new Set(["addition"]) })).toBeNull();
		const renamed: ReviewEvent = { ...event, type: "renamed", added: [] };
		expect(filterEvent(renamed, { ignoreAuthors: new Set(["x"]) })).toBe(renamed);
		expect(filterEvent(renamed, { kinds: new Set(["comment"]) })).toBeNull();
	});
});

describe("ReviewEventLog", () => {
	it("ignores notes outside every armed scope without parsing them", () => {
		const { events } = log();
		expect(events.ingest(NOTE, WITH_COMMENT)).toBeNull();
		expect(events.hasSnapshot(NOTE)).toBe(false);
		expect(events.isArmed(NOTE)).toBe(false);
	});

	it("reports the next mark change in an armed scope", () => {
		const { events } = log();
		events.arm("Notes");
		events.baseline(NOTE, CLEAN);
		const event = events.ingest(NOTE, WITH_COMMENT);
		expect(event).toMatchObject({ seq: 1, type: "changed", path: NOTE, marks: 2 });
		expect(event?.added.map((mark) => mark.kind)).toEqual(["highlight", "comment"]);
	});

	it("ignores edits that leave the marks alone and reports removals", () => {
		const { events } = log();
		events.arm(null);
		events.baseline(NOTE, WITH_COMMENT);
		expect(events.ingest(NOTE, `${WITH_COMMENT}More prose.\n`)).toBeNull();
		const resolved = events.ingest(NOTE, CLEAN);
		expect(resolved?.removed.map((mark) => mark.kind)).toEqual(["highlight", "comment"]);
		expect(resolved?.marks).toBe(0);
	});

	it("reports a new note in an armed scope only when it carries marks", () => {
		const { events } = log();
		events.arm("Notes");
		expect(events.ingest("Notes/empty.md", CLEAN)).toBeNull();
		expect(events.ingest("Notes/new.md", WITH_COMMENT)?.type).toBe("created");
		expect(events.ingest("Elsewhere/new.md", WITH_COMMENT)).toBeNull();
	});

	it("collapses nested scopes to the outermost one", () => {
		const { events } = log();
		events.arm("Notes/Sub");
		events.arm("Notes/Sub/deep.md");
		expect(events.armedScopes).toEqual(["Notes/Sub"]);
		events.arm("Notes");
		expect(events.armedScopes).toEqual(["Notes"]);
		events.arm("Other");
		expect(events.armedScopes).toEqual(["Notes", "Other"]);
		events.arm(null);
		expect(events.armedScopes).toEqual([""]);
	});

	it("reports deletion, rename, and a move out of every watched scope", async () => {
		const { events } = log();
		events.arm("Notes");
		events.baseline(NOTE, WITH_COMMENT);
		expect(events.rename(NOTE, "Notes/moved.md")).toMatchObject({
			type: "renamed",
			path: "Notes/moved.md",
			from: NOTE,
		});
		expect(events.remove("Notes/moved.md")?.type).toBe("deleted");
		events.baseline(NOTE, WITH_COMMENT);
		const waiting = events.wait({ scope: "Notes", since: null, timeoutMs: null, anyChange: false });
		expect(events.rename(NOTE, "Archive/plan.md")).toMatchObject({ type: "deleted", path: NOTE });
		expect(events.hasSnapshot("Archive/plan.md")).toBe(false);
		expect((await waiting).events[0].type).toBe("deleted");
	});

	it("resolves each waiter on its own scope and leaves others waiting", async () => {
		const { events, clock } = log();
		events.arm(null);
		events.baseline(NOTE, CLEAN);
		events.baseline("Other/note.md", CLEAN);
		const onNote = events.wait({ scope: NOTE, since: null, timeoutMs: null, anyChange: false });
		const onOther = events.wait({ scope: "Other", since: null, timeoutMs: 1000, anyChange: false });
		expect(events.pendingWaiters).toBe(2);
		events.ingest(NOTE, WITH_COMMENT);
		const result = await onNote;
		expect(result).toMatchObject({ cursor: 1, timedOut: false });
		expect(events.pendingWaiters).toBe(1);
		clock.advance(1000);
		expect(await onOther).toEqual({ cursor: 1, events: [], timedOut: true, gap: false });
	});

	it("applies each waiter's filter independently", async () => {
		const { events } = log();
		events.arm(null);
		events.baseline(NOTE, CLEAN);
		const others = events.wait({
			scope: null,
			since: null,
			timeoutMs: null,
			anyChange: false,
			filter: { ignoreAuthors: new Set(["Bongo Cat"]) },
		});
		const all = events.wait({ scope: null, since: null, timeoutMs: null, anyChange: false });
		events.ingest(NOTE, WITH_COMMENT);
		expect((await all).events).toHaveLength(1);
		expect(events.pendingWaiters).toBe(1);
		events.ingest(NOTE, CLEAN);
		expect(events.pendingWaiters).toBe(1);
		events.ingest(NOTE, `${CLEAN}{{author="Claude">>x<<}}`);
		expect((await others).events[0].seq).toBe(3);
	});

	it("returns kept events after a cursor, filtered, without waiting", async () => {
		const { events } = log();
		events.arm(null);
		events.baseline(NOTE, CLEAN);
		events.ingest(NOTE, WITH_COMMENT);
		events.ingest(NOTE, CLEAN);
		const result = await events.wait({ scope: null, since: 0, timeoutMs: null, anyChange: false });
		expect(result.events.map((event) => event.seq)).toEqual([1, 2]);
		expect(events.eventsSince(0, null, { kinds: new Set(["addition"]) }).events).toEqual([]);
		expect(
			events.eventsSince(0, null, { kinds: new Set(["comment"]) }).events.map((event) => event.seq),
		).toEqual([1, 2]);
	});

	it("flags a gap when the cursor predates the kept events", async () => {
		const { events } = log({ capacity: 2 });
		events.arm(null);
		events.baseline(NOTE, CLEAN);
		for (let i = 0; i < 4; i += 1) events.ingest(NOTE, i % 2 === 0 ? WITH_COMMENT : CLEAN);
		const result = await events.wait({ scope: null, since: 0, timeoutMs: null, anyChange: false });
		expect(result.gap).toBe(true);
		expect(result.events.map((event) => event.seq)).toEqual([3, 4]);
	});

	it("delivers unbuffered edit events only to waiters that asked for any change", async () => {
		const { events } = log();
		events.arm(null);
		events.baseline(NOTE, WITH_COMMENT);
		const any = events.wait({ scope: null, since: null, timeoutMs: null, anyChange: true });
		const marks = events.wait({ scope: null, since: null, timeoutMs: null, anyChange: false });
		events.ingest(NOTE, `${WITH_COMMENT}typing`);
		expect((await any).events[0]).toMatchObject({ type: "edited", seq: 0, path: NOTE });
		expect(events.pendingWaiters).toBe(1);
		events.ingest(NOTE, CLEAN);
		expect((await marks).events[0].type).toBe("changed");
	});

	it("arms the scope it waits on and releases waiters on dispose", async () => {
		const { events } = log();
		const pending = events.wait({ scope: "Notes", since: null, timeoutMs: 5000, anyChange: false });
		expect(events.armedScopes).toEqual(["Notes"]);
		events.dispose();
		expect(await pending).toMatchObject({ events: [], timedOut: true });
	});
});

describe("canvas watching", () => {
	const BOARD = "Boards/plan.canvas";
	const node = (extra: Record<string, unknown> = {}) => ({
		id: "n1",
		type: "text",
		text: "Card text",
		x: 0,
		y: 0,
		width: 200,
		height: 100,
		...extra,
	});
	const thread = (comments: Array<Record<string, unknown>>, resolved = false) => ({
		id: "cc-1",
		dx: 200,
		dy: 0,
		resolved,
		comments,
	});
	const canvas = (nodes: unknown[]) => JSON.stringify({ nodes, edges: [] }, null, "\t");
	const first = { author: "Bongo Cat", authorId: "u1", date: "2026-09-28T10:00:00.000Z", text: "Move this?" };
	const reply = { author: "Claude", date: "2026-09-28T10:05:00.000Z", text: "Done." };

	function armed() {
		const { events } = log();
		events.arm("Boards");
		return events;
	}

	it("reads pins, their comments, and CriticMarkup in text cards", () => {
		const keys = canvasMarkKeys(
			canvas([node({ text: "A {++new++} card", relayComments: [thread([first])] })]),
			400,
		);
		const summaries = [...(keys?.values() ?? [])];
		expect(summaries.map((mark) => [mark.kind, mark.node, mark.thread])).toEqual([
			["addition", "n1", undefined],
			["pin", "n1", "cc-1"],
			["comment", "n1", "cc-1"],
		]);
		expect(summaries[0].line).toBe(1);
		expect(summaries[1]).toMatchObject({ resolved: false, text: "Move this?" });
		expect(summaries[2]).toMatchObject({
			author: "Bongo Cat",
			authorId: "u1",
			date: "2026-09-28T10:00:00.000Z",
			text: "Move this?",
		});
		expect(summaries[2].line).toBeUndefined();
	});

	it("reports a new pin, a reply, and a resolution, and ignores moves", () => {
		const events = armed();
		events.baseline(BOARD, canvas([node()]));
		const opened = events.ingest(BOARD, canvas([node({ relayComments: [thread([first])] })]));
		expect(opened?.added.map((mark) => mark.kind)).toEqual(["pin", "comment"]);
		expect(
			events.ingest(BOARD, canvas([node({ x: 500, relayComments: [thread([first])] })])),
		).toBeNull();
		const replied = events.ingest(BOARD, canvas([node({ relayComments: [thread([first, reply])] })]));
		expect(replied?.added).toEqual([expect.objectContaining({ kind: "comment", author: "Claude", text: "Done." })]);
		expect(replied?.removed).toEqual([]);
		const resolved = events.ingest(
			BOARD,
			canvas([node({ relayComments: [thread([first, reply], true)] })]),
		);
		expect(resolved?.added).toEqual([expect.objectContaining({ kind: "pin", resolved: true })]);
		expect(resolved?.removed).toEqual([expect.objectContaining({ kind: "pin", resolved: false })]);
		const removed = events.ingest(BOARD, canvas([node()]));
		expect(removed?.removed.map((mark) => mark.kind)).toEqual(["pin", "comment", "comment"]);
	});

	it("ignores a draft pin until its first comment is posted", () => {
		const events = armed();
		events.baseline(BOARD, canvas([node()]));
		expect(events.ingest(BOARD, canvas([node({ relayComments: [thread([])] })]))).toBeNull();
		const posted = events.ingest(BOARD, canvas([node({ relayComments: [thread([first])] })]));
		expect(posted?.added.map((mark) => mark.kind)).toEqual(["pin", "comment"]);
		expect(posted?.removed).toEqual([]);
	});

	it("reports CriticMarkup added in a text card", () => {
		const events = armed();
		events.baseline(BOARD, canvas([node()]));
		const event = events.ingest(BOARD, canvas([node({ text: "Card {==text==}{>>why<<}" })]));
		expect(event?.added.map((mark) => [mark.kind, mark.node])).toEqual([
			["highlight", "n1"],
			["comment", "n1"],
		]);
	});

	it("keeps the last good snapshot when a canvas is caught mid-write", () => {
		const events = armed();
		events.baseline(BOARD, canvas([node({ relayComments: [thread([first])] })]));
		expect(events.ingest(BOARD, '{"nodes": [')).toBeNull();
		const event = events.ingest(BOARD, canvas([node({ relayComments: [thread([first, reply])] })]));
		expect(event?.added.map((mark) => mark.text)).toEqual(["Done."]);
	});

	it("skips a new pin opened by an ignored author and filters by the pin kind", () => {
		const events = armed();
		events.baseline(BOARD, canvas([node()]));
		const mine = events.ingest(
			BOARD,
			canvas([node({ relayComments: [thread([{ ...reply, text: "Mine" }])] })]),
		) as ReviewEvent;
		expect(filterEvent(mine, { ignoreAuthors: new Set(["Claude"]) })).toBeNull();
		expect(filterEvent(mine, { kinds: new Set(["pin"]) })?.added.map((mark) => mark.kind)).toEqual(["pin"]);
	});
});
