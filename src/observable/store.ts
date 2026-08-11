export type Subscriber<T> = (value: T) => void;
export type Unsubscriber = () => void;

type Equality<T> = (left: T, right: T) => boolean;

/**
 * A synchronous, dependency-free observable value.
 *
 * `subscribe` follows the Svelte store contract by delivering the current
 * value immediately. `on` is the change-only form used by imperative views.
 */
export class ObservableValue<T> {
	private readonly subscribers = new Set<Subscriber<T>>();
	private readonly listeners = new Set<() => void>();

	constructor(
		private current: T,
		private readonly equals: Equality<T> = Object.is,
	) {}

	get value(): T {
		return this.current;
	}

	set(value: T): boolean {
		if (this.equals(this.current, value)) return false;
		this.current = value;
		this.notify();
		return true;
	}

	subscribe(run: Subscriber<T>): Unsubscriber {
		this.subscribers.add(run);
		run(this.current);
		return () => this.subscribers.delete(run);
	}

	on(listener: () => void): Unsubscriber {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const run of [...this.subscribers]) run(this.current);
		for (const listener of [...this.listeners]) listener();
	}
}

/** A synchronous observable map with idempotent mutation helpers. */
export class ObservableMap<K, V> {
	private map = new Map<K, V>();
	private readonly subscribers = new Set<Subscriber<ObservableMap<K, V>>>();
	private readonly listeners = new Set<() => void>();

	constructor(private readonly equals: Equality<V> = Object.is) {}

	/** A keyed store publishes itself, so `$store.get(key)` works in Svelte. */
	get value(): ObservableMap<K, V> {
		return this;
	}

	get size(): number {
		return this.map.size;
	}

	get(key: K): V | undefined {
		return this.map.get(key);
	}

	has(key: K): boolean {
		return this.map.has(key);
	}

	keys(): K[] {
		return [...this.map.keys()];
	}

	values(): V[] {
		return [...this.map.values()];
	}

	entries(): [K, V][] {
		return [...this.map.entries()];
	}

	set(key: K, value: V): boolean {
		const hasPrevious = this.map.has(key);
		const previous = this.map.get(key) as V;
		if (hasPrevious && this.equals(previous, value)) {
			return false;
		}
		this.map.set(key, value);
		this.notify();
		return true;
	}

	delete(key: K): boolean {
		if (!this.map.delete(key)) return false;
		this.notify();
		return true;
	}

	clear(): boolean {
		if (this.map.size === 0) return false;
		this.map.clear();
		this.notify();
		return true;
	}

	reset(entries: Iterable<readonly [K, V]>): boolean {
		const next = new Map(entries);
		if (this.mapsEqual(next)) return false;
		this.map = next;
		this.notify();
		return true;
	}

	subscribe(run: Subscriber<ObservableMap<K, V>>): Unsubscriber {
		this.subscribers.add(run);
		run(this);
		return () => this.subscribers.delete(run);
	}

	on(listener: () => void): Unsubscriber {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private mapsEqual(other: Map<K, V>): boolean {
		if (this.map.size !== other.size) return false;
		for (const [key, value] of other) {
			if (!this.map.has(key)) return false;
			const previous = this.map.get(key) as V;
			if (!this.equals(previous, value)) {
				return false;
			}
		}
		return true;
	}

	private notify(): void {
		for (const run of [...this.subscribers]) run(this);
		for (const listener of [...this.listeners]) listener();
	}
}
