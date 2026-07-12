import {
	Keymap,
	parseLinktext,
	type App,
	type HoverParent,
} from "obsidian";
import { parseCommentLinks } from "../critic/comment-links";

/** Registered with the Page preview plugin so hover previews on comment
    links follow the user's per-source settings. */
export const COMMENT_LINK_HOVER_SOURCE = "relay-comments";

export interface CommentBodyContext {
	app: App;
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

/**
 * Render a comment body into `container`: plain text verbatim (the
 * containers are pre-wrap, so text nodes keep newlines), [[wikilinks]] as
 * internal links that open in the workspace, and web links as external
 * anchors. Shared by every surface that shows comment text — sidebar
 * thread messages, canvas cards, and the hover popover.
 */
export function renderCommentBody(
	container: HTMLElement,
	text: string,
	ctx: CommentBodyContext,
): void {
	for (const segment of parseCommentLinks(text)) {
		if (segment.kind === "text") {
			container.appendText(segment.text);
		} else if (segment.kind === "wikilink") {
			appendInternalLink(container, segment.target, segment.display, ctx);
		} else {
			appendExternalLink(container, segment.href, segment.display, ctx);
		}
	}
}

function appendInternalLink(
	container: HTMLElement,
	target: string,
	display: string,
	ctx: CommentBodyContext,
): void {
	const anchor = container.createEl("a", {
		cls: "internal-link critic-comment-link",
		text: display,
		attr: { href: target, "data-href": target, rel: "noopener nofollow" },
	});
	const { path } = parseLinktext(target);
	// An empty path is a same-file subpath link ([[#Heading]]) — resolved.
	if (
		path.length > 0 &&
		!ctx.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath)
	) {
		anchor.addClass("is-unresolved");
	}
	const open = (event: MouseEvent) => {
		// The anchor's href is a link target, not a URL, and card-level
		// click handlers (thread selection, canvas fencing) are not part
		// of following a link.
		event.preventDefault();
		event.stopPropagation();
		const paneType =
			Keymap.isModEvent(event) ||
			(event.type === "auxclick" || ctx.openInNewTab === true
				? "tab"
				: false);
		void ctx.app.workspace.openLinkText(target, ctx.sourcePath, paneType);
		ctx.onNavigate?.();
	};
	anchor.addEventListener("click", open);
	anchor.addEventListener("auxclick", (event) => {
		if (event.button === 1) open(event);
	});
	const hoverParent = ctx.hoverParent;
	if (hoverParent) {
		anchor.addEventListener("mouseover", (event) => {
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

function appendExternalLink(
	container: HTMLElement,
	href: string,
	display: string,
	ctx: CommentBodyContext,
): void {
	const anchor = container.createEl("a", {
		cls: "external-link critic-comment-link",
		text: display,
		attr: { href, rel: "noopener nofollow", target: "_blank" },
	});
	// Following the link is the whole click; keep card-level handlers out.
	anchor.addEventListener("click", (event) => {
		event.stopPropagation();
		ctx.onNavigate?.();
	});
}
