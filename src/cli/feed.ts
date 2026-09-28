import type { EventTimers, ReviewEventLog } from "./events";

/**
 * Turns vault and editor notifications into event-log updates. Notes no
 * watched scope covers are dropped before any read. Bursts of
 * notifications for one note collapse into a single read after a short
 * quiet period; a note that never goes quiet is still read at least every
 * `maxWaitMs`, so a run of writes does not hide marks that came and went.
 */
export interface ReviewEventFeed {
	noteChanged(path: string): void;
	noteDeleted(path: string): void;
	noteRenamed(from: string, to: string): void;
	/** Ingest a note now, skipping the quiet period. */
	flush(path: string): Promise<void>;
	dispose(): void;
}

export interface ReviewEventFeedOptions {
	events: ReviewEventLog;
	read(path: string): Promise<string | null>;
	timers: EventTimers;
	/** Quiet period after the last notification before a read. */
	debounceMs?: number;
	/** Longest a note waits for a read while notifications keep coming. */
	maxWaitMs?: number;
	now?: () => number;
}

interface Pending {
	timer: number;
	/** When the first notification of this burst arrived. */
	since: number;
}

export function createReviewEventFeed(options: ReviewEventFeedOptions): ReviewEventFeed {
	const { events, timers } = options;
	const read = (path: string) => options.read(path);
	const now = options.now ?? (() => Date.now());
	const debounceMs = options.debounceMs ?? 250;
	const maxWaitMs = options.maxWaitMs ?? 1000;
	const pending = new Map<string, Pending>();

	const cancel = (path: string): Pending | undefined => {
		const entry = pending.get(path);
		if (entry === undefined) return undefined;
		timers.clearTimeout(entry.timer);
		pending.delete(path);
		return entry;
	};

	const ingest = async (path: string) => {
		pending.delete(path);
		if (!events.isArmed(path)) return;
		const content = await read(path);
		if (content === null) return;
		events.ingest(path, content);
	};

	return {
		noteChanged(path) {
			if (!events.isArmed(path)) return;
			const since = cancel(path)?.since ?? now();
			const delay = Math.max(0, Math.min(debounceMs, since + maxWaitMs - now()));
			pending.set(path, {
				since,
				timer: timers.setTimeout(() => {
					void ingest(path);
				}, delay),
			});
		},
		noteDeleted(path) {
			cancel(path);
			events.remove(path);
		},
		noteRenamed(from, to) {
			cancel(from);
			if (events.hasSnapshot(from)) {
				events.rename(from, to);
			} else if (events.isArmed(to)) {
				// Moved into a watched scope: its marks are news there.
				void ingest(to);
			}
		},
		flush(path) {
			cancel(path);
			return ingest(path);
		},
		dispose() {
			for (const entry of pending.values()) timers.clearTimeout(entry.timer);
			pending.clear();
		},
	};
}
