import { ReviewSidebarView } from "src/ui/ReviewSidebarView";
import type { WorkspaceLeaf } from "obsidian";
import type RelayCommentsPlugin from "src/main";

jest.mock("obsidian", () => ({
	ItemView: class { app = { scope: {} }; },
	Modal: class {},
	Scope: class { register() {} },
	Platform: { isMacOS: false },
}), { virtual: true });

test("pressing Close with a selected thread preserves its button until click", () => {
	let mouseDown: (event: { target: unknown }) => void = () => {};
	Object.defineProperty(globalThis, "document", { configurable: true, value: {
		addEventListener: (_type: string, handler: typeof mouseDown) => { mouseDown = handler; },
		removeEventListener: jest.fn(),
	} });
	try {
		const view = new ReviewSidebarView({} as WorkspaceLeaf, {} as RelayCommentsPlugin);
		const state = view as unknown as {
			selectedItemId: string | null;
			replyDraftItemId: string | null;
			contentEl: { contains: (target: unknown) => boolean };
			render: jest.Mock;
			installOutsideClickListener: () => void;
		};
		const closeButton = {
			closest: (selector: string) => selector.includes(".critic-sidebar-close-button") ? closeButton : null,
		};
		state.contentEl = { contains: target => target === closeButton };
		state.selectedItemId = "thread";
		state.replyDraftItemId = "thread";
		state.render = jest.fn();
		state.installOutsideClickListener();
		mouseDown({ target: closeButton });
		expect(state.render).not.toHaveBeenCalled();
		expect(state.selectedItemId).toBe("thread");
		// A genuine outside press still dismisses the selection.
		mouseDown({ target: { closest: () => null } });
		expect(state.render).toHaveBeenCalledTimes(1);
		expect(state.selectedItemId).toBeNull();
		expect(state.replyDraftItemId).toBeNull();
	} finally {
		Reflect.deleteProperty(globalThis, "document");
	}
});
