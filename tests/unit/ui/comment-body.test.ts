import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const renderMarkdown = jest.fn<() => Promise<void>>();

jest.mock(
	"obsidian",
	() => ({
		Keymap: { isModEvent: jest.fn(() => false) },
		MarkdownRenderChild: class {
			constructor(readonly containerEl: HTMLElement) {}

			registerDomEvent(): void {}
		},
		MarkdownRenderer: { render: renderMarkdown },
	}),
	{ virtual: true },
);

import type { App, Component } from "obsidian";
import { renderCommentBody } from "src/ui/comment-body";

function commentContainer(): HTMLElement {
	return {
		addClass: jest.fn(),
		empty: jest.fn(),
		appendText: jest.fn(),
		contains: jest.fn(() => false),
		isConnected: true,
	} as unknown as HTMLElement;
}

describe("renderCommentBody", () => {
	beforeEach(() => {
		renderMarkdown.mockReset();
		renderMarkdown.mockResolvedValue(undefined);
	});

	it("delegates the authored body to Obsidian's Markdown renderer", () => {
		const container = commentContainer();
		const addChild = jest.fn(<T>(child: T): T => child);
		const component = { addChild } as unknown as Component;
		const app = {} as App;

		renderCommentBody(container, "**bold** and [[Note]]", {
			app,
			component,
			sourcePath: "Folder/Review.md",
		});

		expect(addChild).toHaveBeenCalledTimes(1);
		expect(renderMarkdown).toHaveBeenCalledWith(
			app,
			"**bold** and [[Note]]",
			container,
			"Folder/Review.md",
			addChild.mock.results[0]?.value,
		);
		expect(container.addClass).toHaveBeenCalledWith("markdown-rendered");
		expect(container.addClass).toHaveBeenCalledWith("critic-comment-markdown");
	});

	it("falls back to the source text when rendering fails", async () => {
		const failure = Promise.reject(new Error("postprocessor failed"));
		renderMarkdown.mockReturnValue(failure);
		const container = commentContainer();
		const component = {
			addChild: <T>(child: T): T => child,
		} as Component;

		renderCommentBody(container, "still visible", {
			app: {} as App,
			component,
			sourcePath: "Review.md",
		});
		await failure.catch(() => undefined);
		await Promise.resolve();

		expect(container.empty).toHaveBeenCalled();
		expect(container.appendText).toHaveBeenCalledWith("still visible");
	});
});
