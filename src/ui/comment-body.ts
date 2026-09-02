import {
	Keymap,
	MarkdownRenderChild,
	MarkdownRenderer,
	type App,
	type Component,
	type HoverParent,
} from "obsidian";

/** Registered with the Page preview plugin so hover previews on comment
    links follow the user's per-source settings. */
export const COMMENT_LINK_HOVER_SOURCE = "relay-comments";

export interface CommentBodyContext {
	app: App;
	/** Short-lived owner for embeds and postprocessors created by Obsidian's
	    Markdown renderer. The surface must unload it when replaced. */
	component: Component;
	/** Path of the file the comment lives in; resolves relative links. */
	sourcePath: string;
	/** Owner of page-preview popovers spawned from these links. Omit on
	    transient surfaces (hover popover, canvas card): a nested page
	    preview there gets torn down by the surface's own dismissal
	    handlers mid-use, so those links stay click-only. */
	hoverParent?: HoverParent;
	/** Open internal links in a new tab even on plain click — for
	    surfaces whose active leaf must survive (the canvas card, where
	    in-place navigation would replace the canvas itself). */
	openInNewTab?: boolean;
	/** Called after a link navigates, so the surface can dismiss itself. */
	onNavigate?: () => void;
}

/** Render comment Markdown through Obsidian's own renderer. */
export function renderCommentBody(
	container: HTMLElement,
	text: string,
	ctx: CommentBodyContext,
): void {
	container.addClass("markdown-rendered");
	container.addClass("critic-comment-markdown");
	const child = ctx.component.addChild(new MarkdownRenderChild(container));
	wireCommentLinks(container, child, ctx);
	void MarkdownRenderer.render(
		ctx.app,
		text,
		container,
		ctx.sourcePath,
		child,
	).catch(() => {
		// A third-party Markdown postprocessor can fail independently of the
		// comment. Keep the authored text visible instead of leaving a blank card.
		if (!container.isConnected) return;
		container.empty();
		container.appendText(text);
	});
}

function wireCommentLinks(
	container: HTMLElement,
	child: MarkdownRenderChild,
	ctx: CommentBodyContext,
): void {
	if (ctx.openInNewTab || ctx.onNavigate) {
		const open = (event: MouseEvent): void => {
			const anchor = eventAnchor(container, event);
			if (!anchor) return;
			if (anchor.classList.contains("internal-link")) {
				const target =
					anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
				if (!target) return;
				event.preventDefault();
				event.stopPropagation();
				const paneType =
					ctx.openInNewTab ||
					Keymap.isModEvent(event) ||
					event.type === "auxclick"
						? "tab"
						: false;
				void ctx.app.workspace.openLinkText(target, ctx.sourcePath, paneType);
				ctx.onNavigate?.();
				return;
			}
			// Keep a card-level click handler out of external links. Let the
			// browser perform Obsidian's rendered anchor action before dismissing
			// a transient surface.
			event.stopPropagation();
			if (ctx.onNavigate) {
				window.setTimeout(() => ctx.onNavigate?.(), 0);
			}
		};
		child.registerDomEvent(container, "click", open, { capture: true });
		child.registerDomEvent(container, "auxclick", (event) => {
			if (event.button === 1) open(event);
		}, { capture: true });
	}

	const hoverParent = ctx.hoverParent;
	if (hoverParent) {
		child.registerDomEvent(container, "mouseover", (event) => {
			const anchor = eventAnchor(container, event);
			if (!anchor?.classList.contains("internal-link")) return;
			const target =
				anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
			if (!target) return;
			ctx.app.workspace.trigger("hover-link", {
				event,
				source: COMMENT_LINK_HOVER_SOURCE,
				hoverParent,
				targetEl: anchor,
				linktext: target,
				sourcePath: ctx.sourcePath,
			});
		});
	}
}

function eventAnchor(
	container: HTMLElement,
	event: MouseEvent,
): HTMLAnchorElement | null {
	const target = event.target as Element | null;
	const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
	return anchor && container.contains(anchor) ? anchor : null;
}
