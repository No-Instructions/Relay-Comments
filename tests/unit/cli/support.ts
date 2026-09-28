import type { Identity } from "src/identity/types";
import { ReviewEventLog, type EventTimers } from "src/cli/events";
import { parseCanvas, serializeCanvas } from "src/cli/canvas";
import { applyChanges } from "src/cli/threads";
import { CliError, type CliContext, type CliIdentity } from "src/cli/types";

/** Deterministic timers: nothing fires until `advance` moves the clock. */
export function fakeTimers(): {
	timers: EventTimers;
	advance(ms: number): void;
	pending(): number;
	now(): number;
} {
	const scheduled = new Map<number, { at: number; callback: () => void }>();
	let now = 0;
	let nextId = 0;
	return {
		timers: {
			setTimeout(callback, ms) {
				nextId += 1;
				scheduled.set(nextId, { at: now + ms, callback });
				return nextId;
			},
			clearTimeout(id) {
				scheduled.delete(id);
			},
		},
		advance(ms) {
			now += ms;
			const due = [...scheduled.entries()]
				.filter(([, entry]) => entry.at <= now)
				.sort((a, b) => a[1].at - b[1].at);
			for (const [id, entry] of due) {
				scheduled.delete(id);
				entry.callback();
			}
		},
		pending: () => scheduled.size,
		now: () => now,
	};
}

export interface FakeVault {
	ctx: CliContext;
	notes: Map<string, string>;
	events: ReviewEventLog;
	clock: ReturnType<typeof fakeTimers>;
	/** Simulate the feed noticing an edit made elsewhere. */
	ingest(path: string): void;
	edits: number;
	/** The last edit and whether it was made as the user. */
	lastEdit?: { path: string; asUser: boolean };
}

export function fakeVault(
	initial: Record<string, string>,
	options: {
		identity?: CliIdentity;
		identities?: Identity[];
		readOnly?: string[];
		now?: string;
	} = {},
): FakeVault {
	const notes = new Map(Object.entries(initial));
	const clock = fakeTimers();
	const events = new ReviewEventLog({
		timers: clock.timers,
		now: () => new Date(options.now ?? "2026-09-26T12:00:00.000Z"),
		capacity: 5,
	});
	const normalize = (input: string) =>
		input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	const resolve = (input: string): string | null => {
		const path = normalize(input);
		if (notes.has(path)) return path;
		if (notes.has(`${path}.md`)) return `${path}.md`;
		return null;
	};
	const vault: FakeVault = {
		notes,
		events,
		clock,
		edits: 0,
		ingest(path) {
			events.ingest(path, notes.get(path) ?? "");
		},
		ctx: {
			version: "0.4.0-test",
			events,
			notes: {
				resolve,
				isFolder: (input) => {
					const path = normalize(input);
					if (path === "") return true;
					return [...notes.keys()].some((candidate) => candidate.startsWith(`${path}/`));
				},
				list: (scope) =>
					[...notes.keys()].filter(
						(path) =>
							path.endsWith(".md") &&
							(scope === null || path === scope || path.startsWith(`${scope}/`)),
					),
				resolveWatchable: (input) => {
					const path = normalize(input);
					if (notes.has(path)) return path;
					if (notes.has(`${path}.md`)) return `${path}.md`;
					if (notes.has(`${path}.canvas`)) return `${path}.canvas`;
					return null;
				},
				watchable: (scope) =>
					[...notes.keys()].filter(
						(path) => scope === null || path === scope || path.startsWith(`${scope}/`),
					),
				read: async (path) => notes.get(path) ?? null,
				edit: async (path, plan, how = { asUser: true }) => {
					vault.lastEdit = { path, asUser: how.asUser };
					const current = notes.get(path);
					if (current === undefined) throw new Error(`missing ${path}`);
					if (options.readOnly?.includes(path)) {
						throw new CliError("read_only", "This note is read-only.");
					}
					const changes = plan(current);
					notes.set(path, applyChanges(current, changes));
					vault.edits += 1;
				},
				editCanvas: async (path, update, how = { asUser: true }) => {
					vault.lastEdit = { path, asUser: how.asUser };
					const current = notes.get(path);
					if (current === undefined) throw new Error(`missing ${path}`);
					notes.set(path, serializeCanvas(update(parseCanvas(current))));
					vault.edits += 1;
				},
			},
			identity: async () =>
				options.identity ?? { id: "mqvxlopr0ocsmgv", name: "Claude", source: "configured" },
			identities: () => options.identities ?? [{ id: "mqvxlopr0ocsmgv", name: "Claude" }],
			now: () => new Date(options.now ?? "2026-09-26T12:00:00.000Z"),
		},
	};
	return vault;
}
