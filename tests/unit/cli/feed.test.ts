import { describe, expect, it } from "@jest/globals";
import { ReviewEventLog } from "src/cli/events";
import { createReviewEventFeed } from "src/cli/feed";
import { fakeTimers } from "./support";

describe("createReviewEventFeed", () => {
	function setup() {
		const clock = fakeTimers();
		const notes = new Map<string, string>([
			["a.md", "plain"],
			["Other/b.md", "plain"],
		]);
		const events = new ReviewEventLog({ timers: clock.timers });
		events.arm("a.md");
		events.baseline("a.md", "plain");
		const reads: string[] = [];
		const feed = createReviewEventFeed({
			events,
			timers: clock.timers,
			debounceMs: 100,
			maxWaitMs: 350,
			now: () => clock.now(),
			read: async (path) => {
				reads.push(path);
				return notes.get(path) ?? null;
			},
		});
		return { clock, notes, events, feed, reads };
	}

	it("never reads a note outside every watched scope", async () => {
		const { clock, feed, reads } = setup();
		feed.noteChanged("Other/b.md");
		clock.advance(500);
		await Promise.resolve();
		expect(reads).toEqual([]);
		expect(clock.pending()).toBe(0);
	});

	it("collapses a burst of change notices into one read after the quiet period", async () => {
		const { clock, notes, events, feed, reads } = setup();
		notes.set("a.md", "plain {>>c<<}");
		feed.noteChanged("a.md");
		clock.advance(50);
		feed.noteChanged("a.md");
		clock.advance(50);
		expect(reads).toEqual([]);
		clock.advance(50);
		await Promise.resolve();
		expect(reads).toEqual(["a.md"]);
		expect(events.cursor).toBe(1);
	});

	it("reads a note that never goes quiet once the maximum wait passes", async () => {
		const { clock, notes, events, feed, reads } = setup();
		notes.set("a.md", "plain {>>c<<}");
		for (let elapsed = 0; elapsed < 600; elapsed += 50) {
			feed.noteChanged("a.md");
			clock.advance(50);
			await Promise.resolve();
		}
		expect(reads).toHaveLength(1);
		expect(events.cursor).toBe(1);
		clock.advance(100);
		await Promise.resolve();
		expect(reads).toHaveLength(2);
	});

	it("forwards deletes and renames immediately and cancels pending reads", () => {
		const { clock, events, feed, reads } = setup();
		events.arm(null);
		feed.noteChanged("a.md");
		feed.noteRenamed("a.md", "b.md");
		clock.advance(200);
		expect(reads).toEqual([]);
		expect(events.hasSnapshot("b.md")).toBe(true);
		feed.noteDeleted("b.md");
		expect(events.hasSnapshot("b.md")).toBe(false);
		expect(events.cursor).toBe(2);
	});

	it("reads a note moved into a watched scope", async () => {
		const { notes, events, feed, reads } = setup();
		events.arm("Watched");
		notes.set("Watched/b.md", "{>>c<<}");
		feed.noteRenamed("Other/b.md", "Watched/b.md");
		await Promise.resolve();
		expect(reads).toEqual(["Watched/b.md"]);
		expect(events.cursor).toBe(1);
	});

	it("flushes on demand and drops timers on dispose", async () => {
		const { clock, notes, feed, reads } = setup();
		notes.set("a.md", "{>>x<<}");
		await feed.flush("a.md");
		expect(reads).toHaveLength(1);
		feed.noteChanged("a.md");
		feed.dispose();
		clock.advance(500);
		expect(reads).toHaveLength(1);
	});
});
