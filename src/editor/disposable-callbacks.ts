/// <reference lib="es2021.weakref" />
/**
 * Obsidian can retain removed CodeMirror configurations. A normal no-op wrapper
 * still retains this module's closure scope (and its bundle). These proxies have
 * a native, inert target; deleting the only trap releases our callback entirely.
 * Dispose only after removing the extension from every active editor.
 */
export class DisposableCallbacks {
	private handlers = new Set<WeakRef<{ apply?: unknown }>>();
	private disposed = false;
	private allocations = 0;

	wrap<Args extends unknown[], Result>(
		callback: (...args: Args) => Result,
	): (...args: Args) => Result {
		if (this.disposed) throw new Error("Editor callbacks already disposed");
		const handler: ProxyHandler<typeof callback> = {
			apply(_target, receiver, args) {
				return Reflect.apply(callback, receiver, args) as Result;
			},
		};
		this.handlers.add(new WeakRef(handler));
		if (++this.allocations % 64 === 0) {
			for (const ref of this.handlers) if (!ref.deref()) this.handlers.delete(ref);
		}
		return new Proxy(Function.prototype as typeof callback, handler);
	}

	dispose(): void {
		this.disposed = true;
		for (const ref of this.handlers) {
			const handler = ref.deref();
			if (handler) delete handler.apply;
		}
		this.handlers.clear();
	}
}
