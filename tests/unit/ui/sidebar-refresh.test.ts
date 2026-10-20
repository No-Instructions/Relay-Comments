import { ReviewSidebarView } from "src/ui/ReviewSidebarView";
import { parseCriticMarkup } from "src/critic/parse";
import type { CriticMark } from "src/critic/types";
import type { WorkspaceLeaf } from "obsidian";
import type RelayCommentsPlugin from "src/main";

jest.mock("obsidian", () => ({
	ItemView: class { app = { scope: {} }; },
	Modal: class {},
	Scope: class { register() {} },
	Platform: { isMacOS: false },
}), { virtual: true });

const mark = parseCriticMarkup("{>>Original message<<}")[0];
const item = { kind: "mark", id: mark.id, type: mark.type, mark,
	from: mark.from, to: mark.to, line: mark.line };

interface SidebarState {
	render: jest.Mock;
	selectedItemId: string | null;
	replyDraftItemId: string | null;
	replyDrafts: Map<string, string>;
	editingCommentId: string | null;
	locateItem: (item: unknown) => void;
	startEditingComment: (mark: CriticMark, item: unknown) => void;
	commitThreadReply: (item: unknown, mark: CriticMark, textarea: HTMLTextAreaElement) => Promise<void>;
}

function fixture(inserted = true) {
	let view: ReviewSidebarView;
	const plugin = {
		// These mutations refresh all sidebars after changing editor state.
		locateReviewRange: () => view.refresh(),
		insertReplyToMark: async () => {
			if (inserted) view.refresh();
			return inserted;
		},
	};
	view = new ReviewSidebarView({} as WorkspaceLeaf, plugin as unknown as RelayCommentsPlugin);
	const state = view as unknown as SidebarState;
	state.render = jest.fn();
	return state;
}

test("selecting a thread renders its new selection once", () => {
	const view = fixture();
	view.render.mockImplementation(() => expect(view.replyDraftItemId).toBe(item.id));
	view.locateItem(item);
	expect(view.render).toHaveBeenCalledTimes(1);
});

test("starting an edit renders the editor once", () => {
	const view = fixture();
	view.render.mockImplementation(() => expect(view.editingCommentId).toBe(mark.id));
	view.startEditingComment(mark, item);
	expect(view.render).toHaveBeenCalledTimes(1);
});

test("posting a reply clears the draft before the single editor refresh", async () => {
	const view = fixture();
	const textarea = { value: "A reply" } as HTMLTextAreaElement;
	view.replyDraftItemId = item.id;
	view.replyDrafts.set(item.id, textarea.value);
	view.render.mockImplementation(() => {
		expect(textarea.value).toBe("");
		expect(view.replyDrafts.has(item.id)).toBe(false);
		expect(view.replyDraftItemId).toBeNull();
	});
	await view.commitThreadReply(item, mark, textarea);
	expect(view.render).toHaveBeenCalledTimes(1);
});

test("a failed reply preserves its draft without rebuilding the composer", async () => {
	const view = fixture(false);
	const textarea = { value: "Keep this draft" } as HTMLTextAreaElement;
	await view.commitThreadReply(item, mark, textarea);
	expect(view.render).not.toHaveBeenCalled();
	expect(textarea.value).toBe("Keep this draft");
	expect(view.replyDrafts.get(item.id)).toBe("Keep this draft");
	expect(view.replyDraftItemId).toBe(item.id);
});
