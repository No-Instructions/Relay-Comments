import { describe, expect, it } from "@jest/globals";
import type { CliData, CliFlags, CliHandler } from "obsidian";
import { CLI_COMMANDS } from "src/cli/commands";
import { cliHandler, registerRelayCommentsCli } from "src/cli/registerCli";
import type { CliCommand } from "src/cli/types";
import { fakeVault, type FakeVault } from "./support";

const PLAN = [
	"# Plan",
	"",
	"The first claim needs evidence.",
	"Second line with ==native== text.",
	'{==old passage==}{{author="Bongo Cat">>Is this right?<<}}',
	"A {~~typo~>fix~~} here, first.",
	"",
].join("\n");

const STAMP = "2026-09-26T12:00:00.000Z";
const SIGNED = `{{authorId="mqvxlopr0ocsmgv" author="Claude" date="${STAMP}"`;

function command(id: string): CliCommand {
	const found = CLI_COMMANDS.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`no command ${id}`);
	return found;
}

function vault(overrides: Parameters<typeof fakeVault>[1] = {}): FakeVault {
	return fakeVault(
		{
			"Notes/plan.md": PLAN,
			"Notes/clean.md": "Nothing here.\n",
			"Other/x.md": "{>>lonely<<}\n",
		},
		overrides,
	);
}

async function run(target: FakeVault, id: string, params: CliData) {
	return command(id).run(params, target.ctx);
}

async function json(target: FakeVault, id: string, params: CliData): Promise<Record<string, unknown>> {
	const output = await cliHandler(command(id), target.ctx)({ ...params, format: "json" });
	return JSON.parse(output) as Record<string, unknown>;
}

async function text(target: FakeVault, id: string, params: CliData): Promise<string> {
	return cliHandler(command(id), target.ctx)(params);
}

/** Let a command's async setup run until the condition holds. */
async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 50 && !condition(); i += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	expect(condition()).toBe(true);
}

describe("comments", () => {
	it("reports the version, the signing identity, and the directory", async () => {
		const target = vault();
		const result = await json(target, "comments", {});
		expect(result).toMatchObject({
			ok: true,
			version: "0.4.0-test",
			identity: { id: "mqvxlopr0ocsmgv", name: "Claude", source: "configured" },
			cursor: 0,
			watching: [],
			trackedNotes: 0,
			waiters: 0,
		});
		expect(await text(target, "comments", {})).toContain("identity: Claude (configured)");
	});

	it("says when no identity is configured", async () => {
		const target = vault({ identity: { source: "fallback" }, identities: [] });
		expect(await text(target, "comments", {})).toContain("identity: none configured");
	});
});

describe("comments:threads", () => {
	it("lists a note's threads in order with 1-based lines", async () => {
		const target = vault();
		const result = await json(target, "comments:threads", { path: "Notes/plan" });
		expect(result.path).toBe("Notes/plan.md");
		const threads = result.threads as Array<Record<string, unknown>>;
		expect(threads.map((thread) => [thread.index, thread.kind, thread.line])).toEqual([
			[1, "native-highlight", 4],
			[2, "highlight", 5],
			[3, "substitution", 6],
		]);
		const rendered = await text(target, "comments:threads", { path: "Notes/plan.md" });
		expect(rendered).toContain("Notes/plan.md: 3 threads");
		expect(rendered).toContain('2. highlight L5 "old passage"');
		expect(rendered).toContain("   Bongo Cat: Is this right?");
		expect(rendered).toContain('3. substitution L6 "typo" → "fix"');
	});

	it("scans a folder or the whole vault for notes with threads", async () => {
		const target = vault();
		const folder = await json(target, "comments:threads", { path: "Notes/" });
		expect(folder.folder).toBe("Notes");
		expect((folder.notes as Array<{ path: string }>).map((note) => note.path)).toEqual([
			"Notes/plan.md",
		]);
		const everything = await json(target, "comments:threads", { path: "/" });
		expect((everything.notes as Array<{ path: string }>).map((note) => note.path)).toEqual([
			"Notes/plan.md",
			"Other/x.md",
		]);
	});

	it("hides resolved threads with --open", async () => {
		const target = vault();
		target.notes.set("Other/x.md", '{==a==}{{author="A" resolved="true">>done<<}}\n{==b==}{>>open<<}\n');
		const result = await json(target, "comments:threads", { path: "Other/x.md", open: "true" });
		expect((result.threads as Array<{ text: string }>).map((thread) => thread.text)).toEqual(["b"]);
	});

	it("answers a missing note with an error envelope", async () => {
		const target = vault();
		expect(await json(target, "comments:threads", { path: "Nope.md" })).toEqual({
			ok: false,
			code: "note_not_found",
			message: "No note, canvas, or folder at Nope.md",
		});
		expect(await text(target, "comments:threads", { path: "Nope.md" })).toBe(
			"Error: No note, canvas, or folder at Nope.md",
		);
	});
});

describe("comments:comment", () => {
	it("wraps the quoted passage in a highlight and signs the comment with a date", async () => {
		const target = vault();
		const result = await json(target, "comments:comment", {
			path: "Notes/plan.md",
			quote: "first claim",
			text: "Cite the source.",
		});
		expect(target.notes.get("Notes/plan.md")).toContain(
			`The {==first claim==}${SIGNED}>>Cite the source.<<}} needs evidence.`,
		);
		expect(result).toMatchObject({
			ok: true,
			signedAs: "Claude",
			identitySource: "configured",
			thread: { index: 1, kind: "highlight", line: 3, text: "first claim" },
		});
	});

	it("attaches to a native highlight without rewriting it", async () => {
		const target = vault();
		await run(target, "comments:comment", {
			path: "Notes/plan.md",
			quote: "native",
			text: "Why highlighted?",
		});
		expect(target.notes.get("Notes/plan.md")).toContain(
			`==native==${SIGNED}>>Why highlighted?<<}} text.`,
		);
	});

	it("signs as a directory identity or a plain name on request", async () => {
		const target = vault({ identities: [{ id: "abc123", name: "Reviewer Bot" }] });
		await run(target, "comments:comment", {
			path: "Notes/plan.md",
			quote: "first claim",
			text: "one",
			author: "abc123",
		});
		expect(target.notes.get("Notes/plan.md")).toContain('{{authorId="abc123" author="Reviewer Bot" date=');
		const result = await json(target, "comments:comment", {
			path: "Notes/plan.md",
			quote: "evidence",
			text: "two",
			author: "Guest",
		});
		expect(target.notes.get("Notes/plan.md")).toContain(`{==evidence==}{{author="Guest" date="${STAMP}">>two<<}}`);
		expect(result).toMatchObject({ signedAs: "Guest", identitySource: "flag" });
	});

	it("writes an unsigned dated comment when the plugin has no identity", async () => {
		const target = vault({ identity: { source: "fallback" } });
		const result = await json(target, "comments:comment", {
			path: "Notes/plan.md",
			quote: "first claim",
			text: "hello",
		});
		expect(target.notes.get("Notes/plan.md")).toContain(`{==first claim==}{{date="${STAMP}">>hello<<}}`);
		expect(result).toMatchObject({ signedAs: null, identitySource: "fallback" });
	});

	it("refuses an ambiguous quote, a missing quote, and a passage inside a mark", async () => {
		const target = vault();
		expect(
			await json(target, "comments:comment", { path: "Notes/plan.md", quote: "e", text: "x" }),
		).toMatchObject({ ok: false, code: "ambiguous_quote" });
		expect(
			await json(target, "comments:comment", { path: "Notes/plan.md", quote: "absent", text: "x" }),
		).toMatchObject({ ok: false, code: "quote_not_found", occurrences: [] });
		expect(
			await json(target, "comments:comment", {
				path: "Notes/plan.md",
				quote: "old passage",
				text: "x",
			}),
		).toMatchObject({ ok: false, code: "overlaps_mark" });
		expect(target.notes.get("Notes/plan.md")).toBe(PLAN);
	});

	it("picks the occurrence on the given line", async () => {
		const target = vault();
		await run(target, "comments:comment", {
			path: "Notes/plan.md",
			quote: "first",
			line: "6",
			text: "x",
		});
		expect(target.notes.get("Notes/plan.md")).toContain("The first claim needs");
		expect(target.notes.get("Notes/plan.md")).toContain(`here, {==first==}${SIGNED}>>x<<}}.`);
	});
});

describe("comments:reply", () => {
	it("appends a signed reply after the thread's last comment", async () => {
		const target = vault();
		const result = await json(target, "comments:reply", {
			path: "Notes/plan.md",
			thread: "2",
			text: "Yes, verified.",
		});
		expect(target.notes.get("Notes/plan.md")).toContain(
			`{==old passage==}{{author="Bongo Cat">>Is this right?<<}}${SIGNED}>>Yes, verified.<<}}`,
		);
		const thread = result.thread as { comments: Array<{ author: string }> };
		expect(thread.comments.map((comment) => comment.author)).toEqual(["Bongo Cat", "Claude"]);
	});

	it("accepts the anchor id as the thread reference", async () => {
		const target = vault();
		const listed = await json(target, "comments:threads", { path: "Notes/plan.md" });
		const id = (listed.threads as Array<{ id: string }>)[2].id;
		await run(target, "comments:reply", { path: "Notes/plan.md", thread: id, text: "ok" });
		expect(target.notes.get("Notes/plan.md")).toContain(`{~~typo~>fix~~}${SIGNED}>>ok<<}} here`);
	});

	it("refuses an unknown thread and a read-only note", async () => {
		const target = vault({ readOnly: ["Other/x.md"] });
		expect(
			await json(target, "comments:reply", { path: "Notes/plan.md", thread: "9", text: "x" }),
		).toMatchObject({ ok: false, code: "thread_not_found" });
		expect(
			await json(target, "comments:reply", { path: "Other/x.md", thread: "1", text: "x" }),
		).toMatchObject({ ok: false, code: "read_only" });
	});
});

describe("comments:resolve", () => {
	it("removes the thread and unwraps the highlight", async () => {
		const target = vault();
		const result = await json(target, "comments:resolve", { path: "Notes/plan.md", thread: "2" });
		expect(target.notes.get("Notes/plan.md")).toContain("\nold passage\nA {~~typo~>fix~~} here, first.");
		expect(result).toMatchObject({ ok: true, threads: 2, resolved: { kind: "highlight", index: 2 } });
	});
});

describe("comments:accept and :reject", () => {
	it("applies the suggestion either way", async () => {
		const accepted = vault();
		await run(accepted, "comments:accept", { path: "Notes/plan.md", thread: "3" });
		expect(accepted.notes.get("Notes/plan.md")).toContain("A fix here, first.");
		const rejected = vault();
		await run(rejected, "comments:reject", { path: "Notes/plan.md", thread: "3" });
		expect(rejected.notes.get("Notes/plan.md")).toContain("A typo here, first.");
	});

	it("refuses a thread that is not a suggestion", async () => {
		const target = vault();
		expect(
			await json(target, "comments:accept", { path: "Notes/plan.md", thread: "2" }),
		).toMatchObject({ ok: false, code: "not_a_suggestion" });
	});
});

describe("comments:suggest", () => {
	it("writes a substitution, an insertion, or a deletion", async () => {
		const target = vault();
		await run(target, "comments:suggest", {
			path: "Notes/plan.md",
			quote: "first claim",
			replace: "main claim",
		});
		expect(target.notes.get("Notes/plan.md")).toContain("The {~~first claim~>main claim~~} needs");
		await run(target, "comments:suggest", {
			path: "Notes/plan.md",
			quote: "evidence",
			insert: " (cite)",
		});
		expect(target.notes.get("Notes/plan.md")).toContain("needs evidence{++ (cite)++}.");
		const result = await json(target, "comments:suggest", {
			path: "Notes/plan.md",
			quote: "Second line with",
			delete: "true",
		});
		expect(target.notes.get("Notes/plan.md")).toContain("{--Second line with--} ==native==");
		expect(result).toMatchObject({ thread: { kind: "deletion", line: 4 } });
	});

	it("attaches a signed comment explaining the suggestion", async () => {
		const target = vault();
		await run(target, "comments:suggest", {
			path: "Notes/plan.md",
			quote: "first claim",
			replace: "main claim",
			comment: "Clearer.",
		});
		expect(target.notes.get("Notes/plan.md")).toContain(
			`{~~first claim~>main claim~~}${SIGNED}>>Clearer.<<}} needs`,
		);
	});

	it("insists on exactly one edit mode", async () => {
		const target = vault();
		expect(
			await json(target, "comments:suggest", { path: "Notes/plan.md", quote: "first claim" }),
		).toMatchObject({ ok: false, code: "invalid_value" });
		expect(
			await json(target, "comments:suggest", {
				path: "Notes/plan.md",
				quote: "first claim",
				replace: "a",
				delete: "true",
			}),
		).toMatchObject({ ok: false, code: "invalid_value" });
	});
});

describe("comments:watch", () => {
	it("tracks only the watched folder and returns kept events after a cursor", async () => {
		const target = vault();
		target.events.arm("Notes");
		target.events.baseline("Notes/plan.md", PLAN);
		target.ingest("Other/x.md");
		expect(target.events.hasSnapshot("Other/x.md")).toBe(false);
		target.notes.set("Notes/plan.md", `${PLAN}{>>new<<}\n`);
		target.ingest("Notes/plan.md");
		const result = await json(target, "comments:watch", { path: "Notes", since: "0" });
		expect(result).toMatchObject({ ok: true, scope: "Notes", cursor: 1, timedOut: false, gap: false });
		const events = result.events as Array<Record<string, unknown>>;
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ seq: 1, type: "changed", path: "Notes/plan.md", marks: 4 });
		expect(target.events.hasSnapshot("Notes/clean.md")).toBe(true);
		expect(target.events.hasSnapshot("Other/x.md")).toBe(false);
	});

	it("blocks until the next review change in the watched note", async () => {
		const target = vault();
		target.events.arm("Other");
		target.events.baseline("Other/x.md", target.notes.get("Other/x.md") ?? "");
		const pending = run(target, "comments:watch", { path: "Notes/plan.md" });
		await until(() => target.events.pendingWaiters === 1);
		target.notes.set("Other/x.md", "{>>lonely<<}{>>again<<}\n");
		target.ingest("Other/x.md");
		expect(target.events.cursor).toBe(1);
		expect(target.events.pendingWaiters).toBe(1);
		await run(target, "comments:reply", { path: "Notes/plan.md", thread: "2", text: "hi" });
		target.ingest("Notes/plan.md");
		const result = await pending;
		expect(result.data).toMatchObject({ scope: "Notes/plan.md", cursor: 2 });
		const [event] = (result.data as { events: Array<Record<string, unknown>> }).events;
		expect(event).toMatchObject({ seq: 2, path: "Notes/plan.md" });
		expect(result.text).toContain("#2 changed Notes/plan.md (4 marks)");
		expect(result.text).toContain('  + comment L5 Claude: "hi"');
		expect(result.text).toContain("cursor: 2");
	});

	it("skips its own writes with ignore-author and wakes on someone else's", async () => {
		const target = vault();
		const pending = run(target, "comments:watch", { path: "Notes", "ignore-author": "Claude" });
		await until(() => target.events.pendingWaiters === 1);
		await run(target, "comments:comment", { path: "Notes/plan.md", quote: "first claim", text: "mine" });
		target.ingest("Notes/plan.md");
		expect(target.events.pendingWaiters).toBe(1);
		await run(target, "comments:reply", {
			path: "Notes/plan.md",
			thread: "2",
			text: "theirs",
			author: "Bongo Cat",
		});
		target.ingest("Notes/plan.md");
		const result = await pending;
		const [event] = (result.data as { events: Array<{ added: Array<{ author?: string }> }> }).events;
		expect(event.added.map((mark) => mark.author)).toEqual(["Bongo Cat"]);
	});

	it("filters by kind", async () => {
		const target = vault();
		const pending = run(target, "comments:watch", { path: "Notes/plan.md", kind: "addition,deletion" });
		await until(() => target.events.pendingWaiters === 1);
		await run(target, "comments:comment", { path: "Notes/plan.md", quote: "first claim", text: "x" });
		target.ingest("Notes/plan.md");
		expect(target.events.pendingWaiters).toBe(1);
		await run(target, "comments:suggest", { path: "Notes/plan.md", quote: "evidence", insert: "!" });
		target.ingest("Notes/plan.md");
		const result = await pending;
		const [event] = (result.data as { events: Array<{ added: Array<{ kind: string }> }> }).events;
		expect(event.added.map((mark) => mark.kind)).toEqual(["addition"]);
		expect(
			await json(target, "comments:watch", { path: "Notes", kind: "reply" }),
		).toMatchObject({
			ok: false,
			code: "invalid_value",
			message:
				'kind must be one or more of comment, highlight, addition, deletion, substitution, pin, got "reply"',
		});
	});

	it("gives up after the timeout with the current cursor", async () => {
		const target = vault();
		const pending = run(target, "comments:watch", { path: "Notes", timeout: "2.5" });
		await until(() => target.events.pendingWaiters === 1);
		target.clock.advance(2500);
		const result = await pending;
		expect(result.data).toMatchObject({ scope: "Notes", cursor: 0, timedOut: true, events: [] });
		expect(result.text).toBe("No review changes in Notes within 2.5s\ncursor: 0");
	});

	it("watches a canvas and renders pin events", async () => {
		const target = vault();
		const board = (comments: unknown[]) =>
			JSON.stringify({
				nodes: [
					{ id: "n1", type: "text", text: "Card", x: 0, y: 0, width: 1, height: 1, relayComments: comments.length ? [{ id: "cc-1", dx: 0, dy: 0, comments }] : [] },
				],
				edges: [],
			});
		target.notes.set("Boards/plan.canvas", board([]));
		const pending = run(target, "comments:watch", { path: "Boards/plan" });
		await until(() => target.events.pendingWaiters === 1);
		expect(target.events.hasSnapshot("Boards/plan.canvas")).toBe(true);
		target.notes.set("Boards/plan.canvas", board([{ author: "Bongo Cat", date: "d", text: "Move this?" }]));
		target.ingest("Boards/plan.canvas");
		const result = await pending;
		expect(result.data).toMatchObject({ scope: "Boards/plan.canvas", cursor: 1 });
		expect(result.text).toContain("#1 changed Boards/plan.canvas (2 marks)");
		expect(result.text).toContain('  + pin node n1 [open] "Move this?"');
		expect(result.text).toContain('  + comment node n1 Bongo Cat: "Move this?"');
	});

	it("refuses an unknown scope", async () => {
		const target = vault();
		expect(await json(target, "comments:watch", { path: "Missing" })).toMatchObject({
			ok: false,
			code: "note_not_found",
		});
	});
});

describe("registerRelayCommentsCli", () => {
	it("registers every command with the format flag and an envelope handler", async () => {
		const target = vault();
		const registered: Array<{ id: string; flags: CliFlags | null; handler: CliHandler }> = [];
		const ids = registerRelayCommentsCli(
			{
				registerCliHandler: (id, _description, flags, handler) => {
					registered.push({ id, flags, handler });
				},
			},
			target.ctx,
		);
		expect(ids).toEqual([
			"comments",
			"comments:threads",
			"comments:watch",
			"comments:comment",
			"comments:reply",
			"comments:resolve",
			"comments:accept",
			"comments:reject",
			"comments:suggest",
		]);
		for (const entry of registered) {
			// Not "text|json": the CLI turns each listed value into a shortcut
			// flag and would swallow a text= parameter as --text.
			expect(entry.flags?.format).toEqual({
				value: "json",
				description: "Output JSON instead of text",
			});
		}
		const status = registered.find((entry) => entry.id === "comments");
		expect(JSON.parse(await status!.handler({ format: "json" }))).toMatchObject({ ok: true });
	});
});

describe("undo ownership", () => {
	const user = { id: "u-daniel", name: "Daniel", source: "relay" };
	const agent = { id: "mqvxlopr0ocsmgv", name: "Claude" };
	const target = () =>
		fakeVault(
			{
				"Notes/plan.md": PLAN,
				"Boards/b.canvas": JSON.stringify({
					nodes: [{ id: "n", type: "text", text: "Card text", x: 0, y: 0, width: 1, height: 1, relayComments: [{ id: "cc-1", dx: 0, dy: 0, comments: [{ author: "Daniel", date: "d", text: "q" }] }] }],
					edges: [],
				}),
			},
			{ identity: user, identities: [agent] },
		);

	it("treats a write without author= as the user's own", async () => {
		const vault = target();
		const result = await json(vault, "comments:comment", { path: "Notes/plan.md", quote: "first claim", text: "x" });
		expect(result).toMatchObject({ signedAs: "Daniel", undoable: true });
		expect(vault.lastEdit).toEqual({ path: "Notes/plan.md", asUser: true });
	});

	it("keeps author= naming the user, by id or name, as the user's own", async () => {
		for (const author of ["u-daniel", "Daniel"]) {
			const vault = target();
			await json(vault, "comments:reply", { path: "Notes/plan.md", thread: "2", text: "x", author });
			expect(vault.lastEdit?.asUser).toBe(true);
		}
	});

	it("keeps writes as another identity out of the user's undo history", async () => {
		const vault = target();
		const result = await json(vault, "comments:reply", { path: "Notes/plan.md", thread: "2", text: "x", author: "Claude" });
		expect(result).toMatchObject({ signedAs: "Claude", identitySource: "configured", undoable: false });
		expect(vault.lastEdit).toEqual({ path: "Notes/plan.md", asUser: false });
		await json(vault, "comments:comment", { path: "Notes/plan.md", quote: "evidence", text: "x", author: "Guest" });
		expect(vault.lastEdit?.asUser).toBe(false);
	});

	it("applies to resolve, accept, reject, suggest, and canvas writes", async () => {
		const cases: Array<[string, CliData]> = [
			["comments:resolve", { path: "Notes/plan.md", thread: "2" }],
			["comments:accept", { path: "Notes/plan.md", thread: "3" }],
			["comments:reject", { path: "Notes/plan.md", thread: "3" }],
			["comments:suggest", { path: "Notes/plan.md", quote: "first claim", replace: "main" }],
			["comments:reply", { path: "Boards/b.canvas", thread: "1", text: "x" }],
			["comments:comment", { path: "Boards/b.canvas", node: "n", text: "x" }],
			["comments:resolve", { path: "Boards/b.canvas", thread: "1" }],
		];
		for (const [id, params] of cases) {
			for (const [author, asUser] of [[undefined, true], ["Claude", false]] as const) {
				const vault = target();
				const result = await json(vault, id, author ? { ...params, author } : params);
				expect({ id, author, ok: result.ok, undoable: result.undoable, asUser: vault.lastEdit?.asUser }).toEqual({
					id,
					author,
					ok: true,
					undoable: asUser,
					asUser,
				});
			}
		}
	});
});
