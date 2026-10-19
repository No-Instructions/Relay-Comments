import { CanvasCommentPins, type PinHost } from "src/canvas/pins";

jest.mock("obsidian", () => ({ Platform: { isMobile: false, isMacOS: false } }), { virtual: true });

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
