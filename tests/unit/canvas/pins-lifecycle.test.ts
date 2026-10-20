import { CanvasCommentPins, type PinHost } from "src/canvas/pins";

jest.mock("obsidian", () => ({ Platform: { isMobile: false, isMacOS: false } }), { virtual: true });

test("closing a Canvas cancels placement and removes its document listener", () => {
	const banner = {
		createSpan: jest.fn(), createEl: () => ({ addEventListener: jest.fn() }),
		addEventListener: jest.fn(), remove: jest.fn(),
	};
	const target = {
		isConnected: true, addClass: jest.fn(), removeClass: jest.fn(),
		createDiv: () => banner, addEventListener: jest.fn(), removeEventListener: jest.fn(),
	};
	const doc = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
	Object.defineProperty(globalThis, "window", { configurable: true,
		value: { setInterval: () => 7, clearInterval: jest.fn() } });
	Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
	const pins = new CanvasCommentPins({
		app: { workspace: { activeEditor: null } },
		getCanvasLeaves: () => [], registerInterval: jest.fn(),
	} as unknown as PinHost);
	try {
		pins.start();
		pins.beginPlacement({ canvas: { wrapperEl: target } } as unknown as Parameters<typeof pins.beginPlacement>[0]);
		pins.renderAll();
		expect(banner.remove).not.toHaveBeenCalled();
		target.isConnected = false;
		pins.renderAll();
		expect(banner.remove).toHaveBeenCalledTimes(1);
		expect(target.removeClass).toHaveBeenCalledWith("critic-canvas-placing");
		for (const [type, listener, capture] of target.addEventListener.mock.calls) {
			expect(target.removeEventListener).toHaveBeenCalledWith(type, listener, capture);
		}
		expect(doc.removeEventListener).toHaveBeenCalledWith("keydown", doc.addEventListener.mock.calls[0][1], true);
		pins.renderAll();
		pins.stop();
		expect(banner.remove).toHaveBeenCalledTimes(1);
	} finally {
		pins.stop();
		Reflect.deleteProperty(globalThis, "window");
		Reflect.deleteProperty(globalThis, "document");
	}
});

test("Canvas polling releases closed views even after the last Canvas closes", () => {
	let tick: (() => void) | undefined;
	const observers: Array<{ observe: jest.Mock; disconnect: jest.Mock }> = [];
	const makeLeaf = () => {
		const overlay = { getBoundingClientRect: () => ({ width: 0 }) };
		const el = {
			isConnected: true,
			addEventListener: jest.fn(),
			removeEventListener: jest.fn(),
			querySelector: () => overlay,
			querySelectorAll: () => [],
			getBoundingClientRect: () => ({ width: 0 }),
		};
		return {
			view: { containerEl: el, canvas: { wrapperEl: el, canvasEl: el, nodes: new Map() } },
			el,
		};
	};
	const first = makeLeaf();
	const second = makeLeaf();
	let leaves = [first, second];
	Object.defineProperty(globalThis, "window", { configurable: true, value: {
		setInterval: (callback: () => void) => { tick = callback; return 7; },
		clearInterval: jest.fn(),
	} });
	Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: jest.fn(() => {
		const observer = { observe: jest.fn(), disconnect: jest.fn() };
		observers.push(observer);
		return observer;
	}) });
	const pins = new CanvasCommentPins({
		app: { workspace: { activeEditor: null } },
		getCanvasLeaves: () => leaves,
		getIdentity: () => ({}),
		registerInterval: jest.fn(),
	} as unknown as PinHost);
	try {
		pins.start();
		tick?.();
		tick?.();
		expect(first.el.addEventListener).toHaveBeenCalledTimes(1);
		expect(second.el.addEventListener).toHaveBeenCalledTimes(1);
		expect(observers).toHaveLength(2);
		first.el.isConnected = false;
		leaves = [second];
		tick?.();
		expect(first.el.removeEventListener).toHaveBeenCalledWith(
			"contextmenu", first.el.addEventListener.mock.calls[0][1], { capture: true },
		);
		expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
		expect(second.el.removeEventListener).not.toHaveBeenCalled();
		expect(observers[1].disconnect).not.toHaveBeenCalled();
		second.el.isConnected = false;
		leaves = [];
		tick?.();
		tick?.();
		expect(second.el.removeEventListener).toHaveBeenCalledTimes(1);
		expect(observers[1].disconnect).toHaveBeenCalledTimes(1);
		expect(first.el.removeEventListener).toHaveBeenCalledTimes(1);
		expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
		first.el.isConnected = true;
		leaves = [first];
		tick?.();
		expect(first.el.addEventListener).toHaveBeenCalledTimes(2);
		expect(observers).toHaveLength(3);
		pins.stop();
		expect(first.el.removeEventListener).toHaveBeenCalledTimes(2);
		expect(observers[2].disconnect).toHaveBeenCalledTimes(1);
	} finally {
		pins.stop();
		Reflect.deleteProperty(globalThis, "window");
		Reflect.deleteProperty(globalThis, "MutationObserver");
	}
});

test("Canvas polling stops immediately, ignores queued work and can restart once", () => {
	let queued: (() => void) | undefined;
	const timers = {
		setInterval: jest.fn((callback: () => void) => { queued = callback; return 7; }),
		clearInterval: jest.fn(),
	};
	Object.defineProperty(globalThis, "window", { value: timers, configurable: true });
	try {
		const getCanvasLeaves = jest.fn(() => []);
		const pins = new CanvasCommentPins({
			app: { workspace: { activeEditor: null } },
			getCanvasLeaves, registerInterval: jest.fn(),
		} as unknown as PinHost);
		pins.start();
		pins.start();
		expect(timers.setInterval).toHaveBeenCalledTimes(1);
		queued?.();
		expect(getCanvasLeaves).toHaveBeenCalledTimes(1);
		pins.stop();
		pins.stop();
		expect(timers.clearInterval).toHaveBeenCalledTimes(1);
		getCanvasLeaves.mockClear();
		queued?.();
		expect(getCanvasLeaves).not.toHaveBeenCalled();
		pins.start();
		queued?.();
		expect(getCanvasLeaves).toHaveBeenCalledTimes(1);
		pins.stop();
	} finally {
		Reflect.deleteProperty(globalThis, "window");
	}
});
