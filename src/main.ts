import {
	ItemView,
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	Scope,
	type Editor,
	type EventRef,
	type Hotkey,
	type MarkdownFileInfo,
	type Menu,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";
import {
	getComposerSubmitScopeBinding,
	isComposerSubmitKey,
} from "./ui/composer-keys";
import { CanvasCommentPins } from "./canvas/pins";
import {
	COMMENT_LINK_HOVER_SOURCE,
	renderCommentBody,
} from "./ui/comment-body";
import type { Extension } from "@codemirror/state";
import { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { parseCriticMarkup } from "./critic/parse";
import {
	CRITIC_SECTION_SEPARATOR,
	collectAttachedComments,
} from "./critic/threading";
import {
	replacementForMark,
	type CriticAction,
} from "./critic/transform";
import type { CriticMark, DisplayMode } from "./critic/types";
import {
	clampPreviewSnippet,
	formatMarkDate,
	getSuggestionPreviewParts,
	isSuggestionMark,
	rectDrifted,
} from "./critic/display";
import {
	applyAllInEditor,
	applyCurrentMarkAction,
	replaceMark,
	wrapSelection,
	addSubstitution,
	getCurrentMark,
} from "./editor/commands";
import {
	createReviewEditorExtension,
	type ReviewEditorController,
} from "./editor/extension";
import { ADD_COMMENT_HOTKEYS } from "./editor/hotkeys";
import { createReviewPostProcessor } from "./preview/postprocessor";
import {
	resolveSettings,
	RelayCommentsSettingTab,
	type RelayCommentsSettings,
} from "./settings";
import {
	ReviewSidebarView,
	VIEW_TYPE_CRITIC_REVIEW,
} from "./ui/ReviewSidebarView";
import {
	ConfiguredIdentityResolver,
	createIdentityProviders,
	getRelayIdentitySupportStatus,
	providerById,
	selectIdentityProvider,
} from "./identity/providers";
import type {
	Identity,
	IdentityProvider,
	IdentityProviderId,
	IdentityProviderOption,
	IdentityResolver,
	IdentityResolverId,
} from "./identity/types";
import { formatAuthoredComment } from "./identity/markup";
import {
	collectExternalCommentComponents,
	scrollToExternalComment,
	type ExternalCommentComponent,
	type ExternalCommentState,
} from "./dom/comment-components";

export interface ActiveReviewState {
	file: TFile;
	editor: Editor;
	marks: CriticMark[];
	activeMarkId: string | null;
	commentDraft: CommentDraft | null;
}

export interface CommentDraft {
	filePath: string;
	from: number;
	to: number;
	selectedText: string;
}

export interface ReviewerIdentity {
	id?: string;
	name: string;
	picture?: string;
	color?: string;
	colorLight?: string;
	source: "metadata" | "fallback" | "local" | IdentityResolverId;
}

interface ClientRectLike {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

interface CodeMirrorAdapter {
	coordsAtPos(pos: number): ClientRectLike | null;
	dispatch(spec?: { effects?: unknown }): void;
	dom?: HTMLElement;
	scrollDOM?: HTMLElement;
}

interface ThreadPreviewData {
	kind: "thread" | "suggestion";
	label: string;
	countLabel: string;
	snippet: string;
	sourcePath: string;
	moreLabel: string | null;
	author: string | null;
	date: string | null;
	resolved: boolean;
}

interface ActiveThreadPreview {
	element: HTMLElement;
	anchor: HTMLElement | null;
	originalTitle: string | null;
	originalAriaDescribedBy: string | null;
	returnFocus: (() => void) | null;
	cleanup: () => void;
}

export default class RelayCommentsPlugin
	extends Plugin
	implements ReviewEditorController
{
	settings!: RelayCommentsSettings;
	private renderVersion = 0;
	private commentDraft: CommentDraft | null = null;
	private lastMarkdownPath: string | null = null;
	private lastContentLeaf: WorkspaceLeaf | null = null;
	private externalCommentObserver: MutationObserver | null = null;
	private externalCommentRefreshTimer: number | null = null;
	private reviewSidebarOpenPromise: Promise<void> | null = null;
	private selectionRefreshTimer: number | null = null;
	private canvasPins: CanvasCommentPins | null = null;
	private previewShowTimer: number | null = null;
	private previewHideTimer: number | null = null;
	private activeThreadPreview: ActiveThreadPreview | null = null;
	private previewId = 0;
	private readonly editorExtensions: Extension[] = [];
	private identityProviders: IdentityProvider[] = [];
	private configuredIdentityResolver!: IdentityResolver;
	private readonly identityCache = new Map<string, ReviewerIdentity | null>();
	private readonly identityRequests = new Map<string, Promise<void>>();
	private identityRevision = 0;
	private settingsTab: RelayCommentsSettingTab | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.identityProviders = createIdentityProviders(this.app);
		this.configuredIdentityResolver = new ConfiguredIdentityResolver(
			() => this.settings.identities,
		);

		this.registerView(
			VIEW_TYPE_CRITIC_REVIEW,
			(leaf: WorkspaceLeaf) => new ReviewSidebarView(leaf, this),
		);
		this.editorExtensions.length = 0;
		this.editorExtensions.push(createReviewEditorExtension(this));
		this.registerEditorExtension(this.editorExtensions);
		this.app.workspace.updateOptions();
		this.registerMarkdownPostProcessor(createReviewPostProcessor(this));
		this.settingsTab = new RelayCommentsSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		this.registerHoverLinkSource(COMMENT_LINK_HOVER_SOURCE, {
			display: "Relay Comments",
			defaultMod: true,
		});

		this.addRibbonIcon("message-square-text", "Open Relay Comments", () => {
			void this.toggleReviewSidebarFromRibbon();
		});

		this.registerCommands();
		this.registerWorkspaceEvents();
		this.captureActiveContentLeaf(this.app.workspace.activeLeaf);
		for (const provider of this.identityProviders) {
			if (provider.subscribe) {
				this.register(
					provider.subscribe(() => this.handleIdentityProviderChange()),
				);
			}
		}
		void this.refreshCurrentIdentity();
		this.queueEditorExtensionRefresh(0);
		this.queueEditorExtensionRefresh(250);

		this.canvasPins = new CanvasCommentPins({
			app: this.app,
			getIdentity: () => {
				const identity = this.getCurrentReviewerIdentity();
				return { name: identity.name, id: identity.id, color: identity.color };
			},
			registerInterval: (id) => this.registerInterval(id),
			getCanvasLeaves: () => this.app.workspace.getLeavesOfType("canvas"),
			// The card's composer needs the submit chord before Obsidian's
			// global keymap eats it — same Scope trick as the sidebar view.
			pushComposerScope: (onSubmit) => {
				const binding = getComposerSubmitScopeBinding();
				const scope = new Scope(this.app.scope);
				scope.register(binding.modifiers, binding.key, (event) => {
					if (isComposerSubmitKey(event)) {
						event.preventDefault();
						onSubmit();
						return false;
					}
					return true;
				});
				this.app.keymap.pushScope(scope);
				return () => this.app.keymap.popScope(scope);
			},
		});

		this.app.workspace.onLayoutReady(() => {
			this.captureActiveContentLeaf(this.app.workspace.activeLeaf);
			this.queueEditorExtensionRefresh(0);
			this.queueEditorExtensionRefresh(250);
			this.refreshReviewSidebars();
			this.canvasPins?.start();
		});
	}

	onunload(): void {
		this.canvasPins?.stop();
		this.canvasPins = null;
		this.externalCommentObserver?.disconnect();
		this.externalCommentObserver = null;
		if (this.externalCommentRefreshTimer !== null) {
			window.clearTimeout(this.externalCommentRefreshTimer);
			this.externalCommentRefreshTimer = null;
		}
		this.reviewSidebarOpenPromise = null;
		if (this.selectionRefreshTimer !== null) {
			window.clearTimeout(this.selectionRefreshTimer);
			this.selectionRefreshTimer = null;
		}
		this.hideThreadPreview();
		this.editorExtensions.length = 0;
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CRITIC_REVIEW);
		this.app.workspace.updateOptions();
		this.refreshOpenEditors();
	}

	notifyEditorSelectionChanged(): void {
		if (this.selectionRefreshTimer !== null) {
			window.clearTimeout(this.selectionRefreshTimer);
		}
		this.selectionRefreshTimer = window.setTimeout(() => {
			this.selectionRefreshTimer = null;
			this.refreshReviewSidebars();
		}, 120);
	}

	getDisplayMode(path?: string | null): DisplayMode {
		return "review";
	}

	getRenderVersion(): number {
		return this.renderVersion;
	}

	shouldShowInlineActions(): boolean {
		return this.settings.showInlineActions;
	}

	activateCommentThread(
		path: string | null,
		from: number,
		to: number,
		options?: { focusReply?: boolean },
	): void {
		// The thread is opening where the preview points; keep both around
		// and they compete for the same attention.
		this.hideThreadPreview();
		const filePath = path ?? this.app.workspace.getActiveFile()?.path ?? null;
		if (filePath) {
			this.lastMarkdownPath = filePath;
		}

		const activate = (leaf: WorkspaceLeaf | undefined) => {
			if (leaf?.view instanceof ReviewSidebarView) {
				leaf.view.activateThreadForRange(from, to, options);
			}
		};

		const existing = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CRITIC_REVIEW,
		)[0];
		if (existing) {
			void this.app.workspace.revealLeaf(existing).then(() => activate(existing));
			return;
		}

		if (!this.settings.openSidebarOnCommentSelect) {
			return;
		}

		void this.openReviewSidebar().then(() => {
			activate(this.app.workspace.getLeavesOfType(VIEW_TYPE_CRITIC_REVIEW)[0]);
		});
	}

	queueThreadPreview(
		path: string | null,
		from: number,
		to: number,
		anchor: HTMLElement,
	): void {
		if (!this.settings.showHoverPreview) return;
		const active = document.activeElement;
		if (
			active instanceof HTMLTextAreaElement &&
			active.closest(".critic-sidebar")
		) {
			return;
		}
		const filePath = path ?? this.app.workspace.getActiveFile()?.path ?? null;
		if (!filePath || !anchor.isConnected) return;
		const previewId = this.previewId + 1;
		this.previewId = previewId;
		this.clearPreviewTimers();
		this.previewShowTimer = window.setTimeout(() => {
			if (this.previewId !== previewId || !anchor.isConnected) return;
			this.showThreadPreview(filePath, from, to, anchor.getBoundingClientRect(), {
				anchor,
				returnFocus: null,
				role: "tooltip",
			});
		}, 300);
	}

	scheduleThreadPreviewDismiss(): void {
		if (this.previewShowTimer !== null) {
			window.clearTimeout(this.previewShowTimer);
			this.previewShowTimer = null;
		}
		if (!this.activeThreadPreview) return;
		if (this.previewHideTimer !== null) {
			window.clearTimeout(this.previewHideTimer);
		}
		this.previewHideTimer = window.setTimeout(() => {
			this.hideThreadPreview();
		}, 180);
	}

	hideThreadPreview(): void {
		this.clearPreviewTimers();
		const active = this.activeThreadPreview;
		if (!active) return;
		this.activeThreadPreview = null;
		active.cleanup();
		active.element.remove();
		active.returnFocus?.();
	}

	private clearPreviewTimers(): void {
		if (this.previewShowTimer !== null) {
			window.clearTimeout(this.previewShowTimer);
			this.previewShowTimer = null;
		}
		if (this.previewHideTimer !== null) {
			window.clearTimeout(this.previewHideTimer);
			this.previewHideTimer = null;
		}
	}

	private showThreadPreview(
		filePath: string,
		from: number,
		to: number,
		anchorRect: ClientRectLike,
		options: {
			anchor: HTMLElement | null;
			returnFocus: (() => void) | null;
			role: "tooltip" | "dialog";
		},
	): boolean {
		const data = this.buildThreadPreviewData(filePath, from, to);
		if (!data) return false;
		this.hideThreadPreview();

		const element = this.renderThreadPreview(data, options.role, {
			open: (opts) => this.activateCommentThread(filePath, from, to, opts),
			resolve: () => {
				this.hideThreadPreview();
				this.resolveThreadAtRange(filePath, from, to);
			},
			apply: (action) => {
				this.hideThreadPreview();
				this.applySuggestionActionAtRange(filePath, from, to, action);
			},
		});
		document.body.appendChild(element);
		this.positionThreadPreview(element, anchorRect);
		const previousTitle = options.anchor?.getAttribute("title") ?? null;
		const previousDescribedBy =
			options.anchor?.getAttribute("aria-describedby") ?? null;
		if (options.anchor) {
			options.anchor.removeAttribute("title");
			options.anchor.setAttribute("aria-describedby", element.id);
		}

		const cancelDismiss = () => {
			if (this.previewHideTimer !== null) {
				window.clearTimeout(this.previewHideTimer);
				this.previewHideTimer = null;
			}
		};
		const scheduleDismiss = () => this.scheduleThreadPreviewDismiss();
		// pointerdown rather than mousedown: touch handling that prevents
		// default (canvas pans, editor gestures) suppresses the synthesized
		// mouse events, so mousedown misses outside taps on mobile.
		const onDocumentPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (
				target &&
				(element.contains(target) ||
					(options.anchor?.contains(target) ?? false))
			) {
				return;
			}
			this.hideThreadPreview();
		};
		const onDocumentKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			this.hideThreadPreview();
		};
		const onScroll = () => this.hideThreadPreview();
		// The preview is positioned once at fixed viewport coordinates. Any
		// anchor movement that is not a scroll (window or splitter resize,
		// panes reflowing, zoom changes) would orphan it — watch the anchor
		// and dismiss the moment it drifts.
		const onResize = () => this.hideThreadPreview();
		const anchorHomeRect = options.anchor?.getBoundingClientRect() ?? null;
		const driftWatcher = window.setInterval(() => {
			const watched = options.anchor;
			if (!watched || !anchorHomeRect) return;
			if (
				!watched.isConnected ||
				rectDrifted(anchorHomeRect, watched.getBoundingClientRect())
			) {
				this.hideThreadPreview();
			}
		}, 120);
		// Hover-model dismissal only: a touch pointer always "leaves" when
		// the finger lifts, so this would close the preview 180ms after
		// any tap or scroll inside it. Touch dismisses via outside
		// pointerdown, scroll, or Escape instead.
		const onPointerLeave = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			scheduleDismiss();
		};
		element.addEventListener("pointerenter", cancelDismiss);
		element.addEventListener("pointerleave", onPointerLeave);
		document.addEventListener("pointerdown", onDocumentPointerDown, true);
		document.addEventListener("keydown", onDocumentKeyDown, true);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);

		this.activeThreadPreview = {
			element,
			anchor: options.anchor,
			originalTitle: previousTitle,
			originalAriaDescribedBy: previousDescribedBy,
			returnFocus: options.returnFocus,
			cleanup: () => {
				element.removeEventListener("pointerenter", cancelDismiss);
				element.removeEventListener("pointerleave", onPointerLeave);
				document.removeEventListener(
					"pointerdown",
					onDocumentPointerDown,
					true,
				);
				document.removeEventListener("keydown", onDocumentKeyDown, true);
				document.removeEventListener("scroll", onScroll, true);
				window.removeEventListener("resize", onResize);
				window.clearInterval(driftWatcher);
				if (options.anchor) {
					if (previousTitle === null) {
						options.anchor.removeAttribute("title");
					} else {
						options.anchor.setAttribute("title", previousTitle);
					}
					if (previousDescribedBy === null) {
						options.anchor.removeAttribute("aria-describedby");
					} else {
						options.anchor.setAttribute(
							"aria-describedby",
							previousDescribedBy,
						);
					}
				}
			},
		};
		if (options.role === "dialog") {
			element.focus();
		}
		return true;
	}

	private renderThreadPreview(
		data: ThreadPreviewData,
		role: "tooltip" | "dialog",
		handlers: {
			open: (opts?: { focusReply?: boolean }) => void;
			resolve: () => void;
			apply: (action: CriticAction) => void;
		},
	): HTMLElement {
		// The popover is for reading; everything else is a CTA — reply,
		// resolve, accept/reject, or follow the breadcrumb to the full
		// thread. Thread bodies render their links (following one dismisses
		// the popover); suggestion bodies quote the document and stay plain.
		const wireLink = (link: HTMLElement, act: () => void) => {
			link.addClass("critic-thread-preview-link");
			link.setAttribute("role", "button");
			link.tabIndex = 0;
			link.addEventListener("click", act);
			link.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				act();
			});
		};
		const element = document.createElement("div");
		element.id = `critic-thread-preview-${this.previewId}`;
		element.className = data.resolved
			? "critic-thread-preview is-resolved"
			: "critic-thread-preview";
		element.setAttribute("role", role);
		element.setAttribute(
			role === "dialog" ? "aria-label" : "aria-live",
			role === "dialog" ? "Comment preview" : "polite",
		);
		if (role === "dialog") {
			element.tabIndex = -1;
		}

		const header = element.createDiv({ cls: "critic-thread-preview-header" });
		header.createSpan({ cls: "critic-thread-preview-label", text: data.label });
		if (data.countLabel) {
			wireLink(
				header.createSpan({
					cls: "critic-thread-preview-count",
					text: data.countLabel,
					attr: { "aria-label": "Open thread in sidebar" },
				}),
				() => handlers.open(),
			);
		}
		if (data.resolved) {
			header.createSpan({
				cls: "critic-thread-preview-badge",
				text: "Resolved",
			});
		}
		const message = element.createDiv({
			cls: "critic-thread-preview-message",
		});
		if (data.kind === "thread") {
			renderCommentBody(message, data.snippet, {
				app: this.app,
				sourcePath: data.sourcePath,
				onNavigate: () => this.hideThreadPreview(),
			});
		} else {
			// Suggestion snippets quote the document; linkifying them would
			// put live links where the sidebar shows plain diff chips.
			message.setText(data.snippet);
		}

		const links: Array<{ label: string; aria: string; act: () => void }> =
			data.kind === "suggestion"
				? this.settings.showInlineActions
					? [
							{
								label: "Accept",
								aria: "Accept suggestion",
								act: () => handlers.apply("accept"),
							},
							{
								label: "Reject",
								aria: "Reject suggestion",
								act: () => handlers.apply("reject"),
							},
						]
					: []
				: [
						{
							label: "Reply",
							aria: "Reply in sidebar",
							act: () => handlers.open({ focusReply: true }),
						},
						...(this.settings.showInlineActions && !data.resolved
							? [
									{
										label: "Resolve",
										aria: "Resolve thread",
										act: handlers.resolve,
									},
								]
							: []),
						...(data.moreLabel
							? [
									{
										label: data.moreLabel,
										aria: "Open thread in sidebar",
										act: () => handlers.open(),
									},
								]
							: []),
					];

		const metaParts = [data.author, data.date].filter(
			(part): part is string => Boolean(part),
		);
		if (metaParts.length > 0 || links.length > 0) {
			const meta = element.createDiv({ cls: "critic-thread-preview-meta" });
			meta.appendText(metaParts.join(" · "));
			let separatorNeeded = metaParts.length > 0;
			for (const spec of links) {
				if (separatorNeeded) meta.appendText(" · ");
				separatorNeeded = true;
				wireLink(
					meta.createSpan({
						text: spec.label,
						attr: { "aria-label": spec.aria },
					}),
					spec.act,
				);
			}
		}
		return element;
	}

	private positionThreadPreview(
		element: HTMLElement,
		anchorRect: ClientRectLike,
	): void {
		const margin = 12;
		const gap = 8;
		const width = Math.min(360, Math.max(280, window.innerWidth - margin * 2));
		element.style.width = `${width}px`;
		const previewRect = element.getBoundingClientRect();
		let left = anchorRect.left;
		if (left + width > window.innerWidth - margin) {
			left = window.innerWidth - width - margin;
		}
		left = Math.max(margin, left);

		let top = anchorRect.bottom + gap;
		let placedAbove = false;
		if (top + previewRect.height > window.innerHeight - margin) {
			top = anchorRect.top - previewRect.height - gap;
			placedAbove = true;
		}
		top = Math.max(margin, top);
		element.style.left = `${Math.round(left)}px`;
		element.style.top = `${Math.round(top)}px`;
		// The caret pins the popover to its anchor: aim it at the anchor's
		// horizontal center, kept clear of the rounded corners.
		const caretX = Math.min(
			width - 18,
			Math.max(18, anchorRect.left + (anchorRect.right - anchorRect.left) / 2 - left),
		);
		element.style.setProperty("--critic-preview-caret-x", `${Math.round(caretX)}px`);
		element.toggleClass("is-above", placedAbove);
	}

	getCurrentReviewerIdentity(path?: string | null): ReviewerIdentity {
		const filePath =
			path ?? this.app.workspace.getActiveFile()?.path ?? this.lastMarkdownPath;
		if (!filePath) return fallbackIdentity();
		const key = this.identityCacheKey("current", filePath);
		if (this.identityCache.has(key)) {
			return this.identityCache.get(key) ?? fallbackIdentity();
		}
		this.queueIdentityRequest(key, async () => {
			return this.resolveCurrentIdentity(filePath);
		});
		return fallbackIdentity();
	}

	async getCurrentReviewerIdentityAsync(
		path: string,
	): Promise<ReviewerIdentity> {
		const key = this.identityCacheKey("current", path);
		if (this.identityCache.has(key)) {
			return this.identityCache.get(key) ?? fallbackIdentity();
		}
		const identity = await this.resolveCurrentIdentity(path);
		this.identityCache.set(key, identity);
		return identity ?? fallbackIdentity();
	}

	getReviewerIdentityForMark(
		mark: CriticMark,
		filePath?: string | null,
	): ReviewerIdentity {
		const metadataAuthor = mark.metadata?.author?.trim();
		// Early Relay Comments builds wrote an ID in authorId and a display
		// name in author. Prefer the actual ID when reading those marks.
		const author = mark.metadata?.authorId?.trim() ?? metadataAuthor;
		const unresolvedName =
			mark.metadata?.authorId?.trim() && metadataAuthor
				? metadataAuthor
				: author;
		return this.getReviewerIdentityForAuthorValue(
			author,
			unresolvedName,
			filePath,
		);
	}

	getReviewerIdentityForExternalAuthor(
		author: string | null,
		filePath?: string | null,
	): ReviewerIdentity {
		const normalized = author?.trim() || undefined;
		return this.getReviewerIdentityForAuthorValue(
			normalized,
			normalized,
			filePath,
		);
	}

	private getReviewerIdentityForAuthorValue(
		author: string | undefined,
		unresolvedName: string | undefined,
		filePath?: string | null,
	): ReviewerIdentity {
		if (!author) return fallbackIdentity();
		const resolvedFilePath =
			filePath ??
			this.app.workspace.getActiveFile()?.path ??
			this.lastMarkdownPath;
		if (!resolvedFilePath) {
			return { id: author, name: unresolvedName ?? author, source: "metadata" };
		}
		const key = this.identityCacheKey("author", resolvedFilePath, author);
		if (this.identityCache.has(key)) {
			return (
				this.identityCache.get(key) ?? {
					id: author,
					name: unresolvedName ?? author,
					source: "metadata",
				}
			);
		}
		this.queueIdentityRequest(key, async () => {
			return this.resolveAuthorIdentity(author, resolvedFilePath);
		});
		return { id: author, name: unresolvedName ?? author, source: "metadata" };
	}

	private findMarkRunAtRange(
		filePath: string,
		from: number,
		to: number,
	): {
		mark: CriticMark;
		visibleComments: CriticMark[];
		runFrom: number;
		runTo: number;
	} | null {
		const view = this.getMarkdownViewByPath(filePath);
		const editor = view?.editor;
		if (!view?.file || view.file.path !== filePath || !editor) return null;
		const text = editor.getValue();
		const marks = parseCriticMarkup(text)
			.filter((mark) => mark.valid)
			.sort((a, b) => a.from - b.from || a.to - b.to);
		const consumed = new Set<string>();

		for (let index = 0; index < marks.length; index += 1) {
			const mark = marks[index];
			if (consumed.has(mark.id)) continue;
			const attached = collectAttachedComments(marks, text, index, consumed, {
				allowCommentAnchor: true,
			}).comments;
			consumed.add(mark.id);
			for (const comment of attached) {
				consumed.add(comment.id);
			}
			if (mark.from !== from || mark.to !== to) continue;

			const run = mark.type === "comment" ? [mark, ...attached] : attached;
			const last = run[run.length - 1] ?? mark;
			return {
				mark,
				visibleComments: run.filter(
					(comment) => comment.content.trim().length > 0,
				),
				runFrom: mark.from,
				runTo: Math.max(mark.to, last.to),
			};
		}
		return null;
	}

	private buildThreadPreviewData(
		filePath: string,
		from: number,
		to: number,
	): ThreadPreviewData | null {
		const found = this.findMarkRunAtRange(filePath, from, to);
		if (!found) return null;
		const { mark, visibleComments } = found;

		if (visibleComments.length === 0) {
			const parts = getSuggestionPreviewParts(mark);
			if (!parts) return null;
			const identity = this.getReviewerIdentityForMark(mark, filePath);
			return {
				kind: "suggestion",
				label: parts.label,
				countLabel: "",
				snippet: clampPreviewSnippet(parts.snippet),
				sourcePath: filePath,
				moreLabel: null,
				author: identity.source === "fallback" ? null : identity.name,
				date: formatMarkDate(mark),
				resolved: false,
			};
		}

		const firstComment = visibleComments[0];
		const identity = this.getReviewerIdentityForMark(firstComment, filePath);
		const resolved = [mark, ...visibleComments].some(
			(candidate) => candidate.metadata?.resolved === "true",
		);
		return {
			kind: "thread",
			label: resolved
				? "Resolved comment"
				: isSuggestionMark(mark)
					? "Comment on suggestion"
					: "Comment",
			countLabel:
				visibleComments.length > 1
					? `${visibleComments.length} comments`
					: "",
			snippet: clampPreviewSnippet(firstComment.content),
			sourcePath: filePath,
			moreLabel:
				visibleComments.length > 1
					? `+${visibleComments.length - 1} ${
							visibleComments.length === 2 ? "reply" : "replies"
						}`
					: null,
			author: identity.source === "fallback" ? null : identity.name,
			date: formatMarkDate(firstComment),
			resolved,
		};
	}

	/** Resolve the thread at a range: same semantics as the sidebar's
	    resolve control (comments removed; a suggestion anchor survives). */
	resolveThreadAtRange(filePath: string, from: number, to: number): void {
		const found = this.findMarkRunAtRange(filePath, from, to);
		if (!found || found.visibleComments.length === 0) return;
		const { mark, runFrom, runTo } = found;
		if (mark.type === "comment") {
			this.replaceReviewRangeFromSidebar(runFrom, runTo, "");
		} else if (isSuggestionMark(mark)) {
			this.replaceReviewRangeFromSidebar(mark.to, runTo, "");
		} else {
			this.replaceReviewRangeFromSidebar(runFrom, runTo, mark.content);
		}
		this.refreshReviewSidebars();
	}

	applySuggestionActionAtRange(
		filePath: string,
		from: number,
		to: number,
		action: CriticAction,
	): void {
		const found = this.findMarkRunAtRange(filePath, from, to);
		if (!found || !isSuggestionMark(found.mark)) return;
		if (found.visibleComments.length > 0) {
			this.replaceReviewRangeFromSidebar(
				found.runFrom,
				found.runTo,
				replacementForMark(found.mark, action),
			);
			this.refreshReviewSidebars();
		} else {
			this.applyMarkActionFromSidebar(found.mark, action);
		}
	}

	private showCommentPreviewAtCursor(editor: Editor): void {
		const file = this.getCurrentMarkdownView()?.file;
		if (!file) {
			new Notice("Open a Markdown note to preview comments.");
			return;
		}
		const mark = getCurrentMark(editor);
		if (!mark?.valid) {
			new Notice("No comment thread at the cursor.");
			return;
		}
		const cm = this.getCodeMirrorEditor(editor);
		const anchor = cm ? this.getRenderedRangeElement(cm, mark.from, mark.to) : null;
		const rect =
			anchor?.getBoundingClientRect() ??
			this.getEditorOffsetRect(editor, mark.contentFrom, mark.contentTo, cm);
		if (!rect) {
			new Notice("No visible comment anchor at the cursor.");
			return;
		}
		const shown = this.showThreadPreview(file.path, mark.from, mark.to, rect, {
			anchor,
			returnFocus: () => editor.focus(),
			role: "dialog",
		});
		if (!shown) {
			new Notice("No comment thread at the cursor.");
		}
	}

	private getEditorOffsetRect(
		editor: Editor,
		fromOffset: number,
		toOffset: number,
		cm: CodeMirrorAdapter | null = this.getCodeMirrorEditor(editor),
	): ClientRectLike | null {
		if (!cm) return null;
		const start = cm.coordsAtPos(fromOffset);
		const end = cm.coordsAtPos(Math.max(fromOffset, toOffset - 1));
		if (!start && !end) return null;
		if (!start) return end;
		if (!end) return start;
		return {
			top: Math.min(start.top, end.top),
			bottom: Math.max(start.bottom, end.bottom),
			left: Math.min(start.left, end.left),
			right: Math.max(start.right, end.right),
		};
	}

	async saveSettingsAndRefresh(): Promise<void> {
		await this.saveData(this.settings);
		this.identityRevision += 1;
		this.identityCache.clear();
		void this.refreshCurrentIdentity();
		this.bumpRenderVersion();
	}

	getActiveReviewState(): ActiveReviewState | null {
		const view = this.getCurrentMarkdownView();
		const file = view?.file;
		const editor = view?.editor;
		if (!file || !editor) return null;

		const marks = parseCriticMarkup(editor.getValue());
		const activeMark = getCurrentMark(editor);
		return {
			file,
			editor,
			marks,
			activeMarkId: activeMark?.id ?? null,
			commentDraft:
				this.commentDraft?.filePath === file.path ? this.commentDraft : null,
		};
	}

	getActiveExternalCommentState(): ExternalCommentState | null {
		const leaf = this.lastContentLeaf;
		if (!leaf || leaf.view instanceof MarkdownView) return null;
		const root = this.getLeafContentRoot(leaf);
		if (!root?.isConnected) return null;
		const file = (leaf.view as typeof leaf.view & { file?: TFile | null }).file;
		return {
			title: file?.basename ?? leaf.view.getDisplayText(),
			filePath:
				file?.path ??
				this.app.workspace.getActiveFile()?.path ??
				this.lastMarkdownPath,
			comments: collectExternalCommentComponents(root),
		};
	}

	revealExternalComment(comment: ExternalCommentComponent): boolean {
		if (scrollToExternalComment(comment)) return true;
		if (!comment.key && !comment.thread) return false;
		const replacement = this.getActiveExternalCommentState()?.comments.find(
			(candidate) =>
				(comment.key && candidate.key === comment.key) ||
				(!comment.key &&
					comment.thread &&
					candidate.thread === comment.thread),
		);
		return replacement ? scrollToExternalComment(replacement) : false;
	}

	startCommentDraft(
		path: string | null,
		from: number,
		to: number,
		selectedText: string,
	): void {
		const activeFile = this.app.workspace.getActiveFile();
		const filePath = path ?? activeFile?.path;
		if (!filePath) {
			new Notice("Open a Markdown note before adding a comment.");
			return;
		}
		// CriticMarkup can't express overlapping marks.
		const editorText = this.getMarkdownViewByPath(filePath)?.editor.getValue();
		if (
			editorText &&
			parseCriticMarkup(editorText).some(
				(mark) => mark.from < to && mark.to > from,
			)
		) {
			new Notice(
				"That selection already contains a suggestion or comment.",
			);
			return;
		}
		this.lastMarkdownPath = filePath;
		this.commentDraft = { filePath, from, to, selectedText };
		void this.openReviewSidebar();
		this.refreshReviewSidebars();
	}

	startCommentDraftFromEditor(
		editor: Editor,
		info?: MarkdownView | MarkdownFileInfo,
	): void {
		const fromPos = editor.getCursor("from");
		const toPos = editor.getCursor("to");
		const from = editor.posToOffset(fromPos);
		const to = editor.posToOffset(toPos);
		const selectedText = editor.getSelection();
		if (from === to || selectedText.length === 0) {
			new Notice("Select text to comment on.");
			return;
		}
		this.startCommentDraft(info?.file?.path ?? null, from, to, selectedText);
	}

	async commitCommentDraft(comment: string): Promise<void> {
		if (!this.commentDraft) return;
		const draft = this.commentDraft;
		const view = this.getMarkdownViewByPath(draft.filePath);
		const editor = view?.editor;
		const file = view?.file;
		if (!editor || !file || file.path !== draft.filePath) {
			new Notice("Open the commented note before saving this comment.");
			return;
		}
		if (draft.from === draft.to || draft.selectedText.trim().length === 0) {
			new Notice("Select text to comment on.");
			return;
		}
		const identity = await this.getCurrentReviewerIdentityAsync(draft.filePath);
		// Identity lookup may involve the network. Recheck that the same draft
		// and editor are still active before applying its source edit.
		if (this.commentDraft !== draft) return;
		const refreshedView = this.getMarkdownViewByPath(draft.filePath);
		const refreshedEditor = refreshedView?.editor;
		if (!refreshedEditor || refreshedView.file?.path !== draft.filePath) {
			new Notice("Open the commented note before saving this comment.");
			return;
		}
		const commentMarkup = this.formatAttachedCommentMarkup(comment, identity);
		const insertion = `{==${draft.selectedText}==}${commentMarkup}`;
		refreshedEditor.replaceRange(
			insertion,
			refreshedEditor.offsetToPos(draft.from),
			refreshedEditor.offsetToPos(draft.to),
			"relay-comments",
		);
		this.commentDraft = null;
		this.bumpRenderVersion();
	}

	cancelCommentDraft(): void {
		this.commentDraft = null;
		this.refreshReviewSidebars();
	}

	locateMark(mark: CriticMark): void {
		this.locateReviewRange(mark.from, mark.to);
	}

	locateReviewRange(
		fromOffset: number,
		toOffset: number,
		options: { focusEditor?: boolean; select?: boolean } = {},
	): void {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return;

		const from = editor.offsetToPos(fromOffset);
		const to = editor.offsetToPos(toOffset);
		const cm = this.getCodeMirrorEditor(editor);
		if (options.select !== false) {
			editor.setSelection(from, to);
		}
		this.centerEditorOffset(editor, fromOffset, toOffset, { from, to }, cm);
		if (options.focusEditor !== false) {
			editor.focus();
		}
		this.refreshReviewSidebars();
	}

	getReviewRangeClientRect(
		fromOffset: number,
		toOffset: number,
	): { top: number; bottom: number; left: number; right: number } | null {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		const cm = editor ? this.getCodeMirrorEditor(editor) : null;
		if (!cm) return null;

		const renderedElement = this.getRenderedRangeElement(cm, fromOffset, toOffset);
		if (renderedElement) {
			return rectFromElement(renderedElement);
		}

		const start = cm.coordsAtPos(fromOffset);
		const end = cm.coordsAtPos(Math.max(fromOffset, toOffset - 1));
		if (!start && !end) return null;
		if (!start) return end;
		if (!end) return start;
		return {
			top: Math.min(start.top, end.top),
			bottom: Math.max(start.bottom, end.bottom),
			left: Math.min(start.left, end.left),
			right: Math.max(start.right, end.right),
		};
	}

	private centerEditorOffset(
		editor: Editor,
		offset: number,
		toOffset: number,
		range: { from: ReturnType<Editor["offsetToPos"]>; to: ReturnType<Editor["offsetToPos"]> },
		cm: CodeMirrorAdapter | null = this.getCodeMirrorEditor(editor),
	): void {
		if (cm && this.scrollRenderedRangeIntoView(cm, offset, toOffset)) {
			return;
		}
		if (cm?.dispatch) {
			cm.dispatch({
				effects: CodeMirrorEditorView.scrollIntoView(offset, {
					y: "center",
					yMargin: 80,
				}),
			});
			window.requestAnimationFrame(() => {
				this.scrollRenderedRangeIntoView(cm, offset, toOffset);
			});
			return;
		}
		editor.scrollIntoView(range, true);
	}

	private getCodeMirrorEditor(editor: Editor): CodeMirrorAdapter | null {
		return (editor as unknown as { cm?: CodeMirrorAdapter }).cm ?? null;
	}

	getAvailableIdentityProviders(): IdentityProviderOption[] {
		return this.identityProviders
			.filter((provider) => provider.isAvailable())
			.map(({ id, name }) => ({ id, name }));
	}

	getSelectedIdentityProviderId(): IdentityProviderId | null {
		return (
			selectIdentityProvider(
				this.identityProviders,
				this.settings.identityProvider,
			)?.id ?? null
		);
	}

	getRelayIdentitySupportStatus(): ReturnType<
		typeof getRelayIdentitySupportStatus
	> {
		return getRelayIdentitySupportStatus(this.app);
	}

	private async refreshCurrentIdentity(): Promise<void> {
		const path =
			this.app.workspace.getActiveFile()?.path ?? this.lastMarkdownPath;
		if (!path) return;
		await this.getCurrentReviewerIdentityAsync(path);
		this.bumpRenderVersion();
	}

	private getSelectedIdentityProvider(): IdentityProvider | null {
		const selected = this.getSelectedIdentityProviderId();
		return selected ? providerById(this.identityProviders, selected) : null;
	}

	private async resolveCurrentIdentity(
		path: string,
	): Promise<ReviewerIdentity | null> {
		const provider = this.getSelectedIdentityProvider();
		if (provider) {
			try {
				const identity = await provider.getCurrentUser(path);
				if (identity) return providerIdentity(identity, provider.id);
			} catch {
				// Providers are optional integrations. A failure must not
				// prevent standalone comments from working.
			}
		}
		return provider ? null : this.getLocalReviewerIdentity();
	}

	private async resolveAuthorIdentity(
		author: string,
		path: string,
	): Promise<ReviewerIdentity | null> {
		const provider = this.getSelectedIdentityProvider();
		const resolvers: IdentityResolver[] = [
			...(provider ? [provider] : []),
			this.configuredIdentityResolver,
		];
		for (const resolver of resolvers) {
			if (!resolver.isAvailable()) continue;
			try {
				const identity = await resolver.resolveUser(author, path);
				if (identity) return providerIdentity(identity, resolver.id);
			} catch {
				// Resolver failures degrade to the unresolved author value
				// instead of breaking review rendering.
			}
		}
		const local = this.getLocalReviewerIdentity();
		if (local?.id === author) return local;
		return null;
	}

	private getLocalReviewerIdentity(): ReviewerIdentity | null {
		const name = this.settings.authorName.trim();
		if (!name) return null;
		const picture = this.settings.authorPicture.trim();
		return {
			id: name,
			name,
			...(picture ? { picture } : {}),
			source: "local",
		};
	}

	private queueIdentityRequest(
		key: string,
		resolve: () => Promise<ReviewerIdentity | null>,
	): void {
		if (this.identityRequests.has(key)) return;
		const request = resolve()
			.then((identity) => {
				this.identityCache.set(key, identity);
				this.bumpRenderVersion();
			})
			.catch(() => {
				this.identityCache.set(key, null);
			})
			.finally(() => {
				this.identityRequests.delete(key);
			});
		this.identityRequests.set(key, request);
	}

	private identityCacheKey(
		kind: "current" | "author",
		path: string,
		author = "",
	): string {
		return [
			this.identityRevision,
			kind,
			this.getSelectedIdentityProviderId() ?? "",
			this.settings.authorName,
			this.settings.authorPicture,
			path,
			author,
		].join("\u0000");
	}

	private scrollRenderedRangeIntoView(
		cm: CodeMirrorAdapter,
		fromOffset: number,
		toOffset: number,
	): boolean {
		const element = this.getRenderedRangeElement(cm, fromOffset, toOffset);
		if (!element) return false;
		element.scrollIntoView({ block: "center", inline: "nearest" });
		return true;
	}

	private getRenderedRangeElement(
		cm: CodeMirrorAdapter,
		fromOffset: number,
		toOffset: number,
	): HTMLElement | null {
		const root = cm.dom;
		if (!root) return null;

		return (
			Array.from(
				root.querySelectorAll<HTMLElement>("[data-critic-from][data-critic-to]"),
			).find(
				(element) =>
					Number(element.dataset.criticFrom) === fromOffset &&
					Number(element.dataset.criticTo) === toOffset,
			) ?? null
		);
	}

	applyMarkActionFromSidebar(mark: CriticMark, action: CriticAction): void {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return;
		replaceMark(editor, mark, action);
		this.refreshReviewSidebars();
		this.bumpRenderVersion();
	}

	replaceReviewRangeFromSidebar(
		fromOffset: number,
		toOffset: number,
		replacement: string,
	): void {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return;
		editor.replaceRange(
			replacement,
			editor.offsetToPos(fromOffset),
			editor.offsetToPos(toOffset),
			"relay-comments",
		);
		this.bumpRenderVersion();
	}

	async insertReplyToMark(mark: CriticMark, reply: string): Promise<boolean> {
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		const path = view?.file?.path;
		if (!editor || !path) return false;
		const identity = await this.getCurrentReviewerIdentityAsync(path);
		const refreshedView = this.getCurrentMarkdownView();
		const refreshedEditor = refreshedView?.editor;
		if (!refreshedEditor || refreshedView.file?.path !== path) return false;
		const cm = this.getCodeMirrorEditor(refreshedEditor);
		const scrollTop = cm?.scrollDOM?.scrollTop;
		refreshedEditor.replaceRange(
			this.formatAttachedCommentMarkup(reply, identity),
			refreshedEditor.offsetToPos(mark.to),
			undefined,
			"relay-comments",
		);
		this.bumpRenderVersion();
		if (typeof scrollTop === "number" && cm?.scrollDOM) {
			window.requestAnimationFrame(() => {
				if (cm.scrollDOM) {
					cm.scrollDOM.scrollTop = scrollTop;
				}
			});
		}
		return true;
	}

	updateCommentTextFromSidebar(mark: CriticMark, text: string): boolean {
		if (mark.type !== "comment") return false;
		const view = this.getCurrentMarkdownView();
		const editor = view?.editor;
		if (!editor) return false;
		const range = mark.ranges.commentText ?? [mark.contentFrom, mark.contentTo];
		editor.replaceRange(
			sanitizeCommentText(text),
			editor.offsetToPos(range[0]),
			editor.offsetToPos(range[1]),
			"relay-comments",
		);
		this.bumpRenderVersion();
		return true;
	}

	private formatCommentMarkup(
		comment: string,
		identity: ReviewerIdentity,
	): string {
		const content = sanitizeCommentText(comment);
		return formatAuthoredComment(content, identity.id);
	}

	private formatAttachedCommentMarkup(
		comment: string,
		identity: ReviewerIdentity,
	): string {
		return `${CRITIC_SECTION_SEPARATOR}${this.formatCommentMarkup(
			comment,
			identity,
		)}`;
	}

	async openReviewSidebar(): Promise<void> {
		if (this.reviewSidebarOpenPromise) {
			return this.reviewSidebarOpenPromise;
		}

		this.reviewSidebarOpenPromise = this.openReviewSidebarOnce().finally(() => {
			this.reviewSidebarOpenPromise = null;
		});
		return this.reviewSidebarOpenPromise;
	}

	private async openReviewSidebarOnce(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CRITIC_REVIEW,
		)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({ type: VIEW_TYPE_CRITIC_REVIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
		this.refreshReviewSidebars();
	}

	private async toggleReviewSidebarFromRibbon(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CRITIC_REVIEW,
		)[0];
		if (existing && this.isReviewSidebarActiveVisible(existing)) {
			this.closeReviewSidebar(existing);
			return;
		}
		await this.openReviewSidebar();
	}

	private isReviewSidebarActiveVisible(leaf: WorkspaceLeaf): boolean {
		const rightSplit = (
			this.app.workspace as typeof this.app.workspace & {
				rightSplit?: { collapsed?: boolean };
			}
		).rightSplit;
		return this.app.workspace.activeLeaf === leaf && rightSplit?.collapsed !== true;
	}

	closeReviewSidebar(leaf?: WorkspaceLeaf): void {
		this.reviewSidebarOpenPromise = null;
		const leaves =
			leaf !== undefined
				? [leaf]
				: this.app.workspace.getLeavesOfType(VIEW_TYPE_CRITIC_REVIEW);
		// On mobile, closing means sliding the whole drawer away. The view
		// must stay attached while it slides: detaching first re-renders
		// the drawer onto its next tab for the entire close animation
		// (Outline's "No headings found", caught by a blind demo review
		// on device — an earlier review caught the detach-only variant
		// stranding the drawer on Obsidian's "Empty" placeholder).
		// Reopening reveals the kept leaf.
		if (Platform.isMobile && leaves.length > 0) {
			const rightSplit = (
				this.app.workspace as typeof this.app.workspace & {
					rightSplit?: { collapse?: () => void };
				}
			).rightSplit;
			rightSplit?.collapse?.();
			return;
		}
		for (const reviewLeaf of leaves) {
			reviewLeaf.detach();
		}
	}

	refreshReviewSidebars(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			VIEW_TYPE_CRITIC_REVIEW,
		)) {
			if (leaf.view instanceof ReviewSidebarView) {
				leaf.view.refresh();
			}
		}
	}

	private async loadSettings(): Promise<void> {
		this.settings = resolveSettings(await this.loadData());
	}

	private registerCommands(): void {
		this.addCommand({
			id: "open-review-sidebar",
			name: "Open review sidebar",
			callback: () => {
				void this.openReviewSidebar();
			},
		});
		this.addCommand({
			id: "close-review-sidebar",
			name: "Close review sidebar",
			callback: () => {
				this.closeReviewSidebar();
			},
		});
		this.addCommand({
			id: "add-canvas-comment",
			name: "Add comment to canvas (click to place)",
			// Same chord as the editor's add-comment: the check limits it
			// to canvas views, so the two commands never collide.
			hotkeys: ADD_COMMENT_HOTKEYS,
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(ItemView);
				if (view?.getViewType() !== "canvas") return false;
				if (!checking) this.canvasPins?.beginPlacement(view as never);
				return true;
			},
		});
		this.addEditorCommand(
			"show-comment-preview-at-cursor",
			"Show comment preview at cursor",
			(editor) => this.showCommentPreviewAtCursor(editor),
		);
		this.addEditorCommand("add-addition", "Mark selection as addition", (editor) =>
			wrapSelection(editor, "addition"),
		);
		this.addEditorCommand("add-deletion", "Mark selection as deletion", (editor) =>
			wrapSelection(editor, "deletion"),
		);
		this.addEditorCommand("add-substitution", "Mark selection as substitution", (editor) =>
			addSubstitution(this.app, editor),
		);
		this.addEditorCommand(
			"add-comment",
			"Add comment",
			(editor) => this.startCommentDraftFromEditor(editor),
			ADD_COMMENT_HOTKEYS,
		);
		this.addEditorCommand("add-highlight", "Highlight selection", (editor) =>
			wrapSelection(editor, "highlight"),
		);
		this.addEditorCommand("accept-current", "Accept current comment or suggestion", (editor) => {
			applyCurrentMarkAction(editor, "accept");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("reject-current", "Reject current comment or suggestion", (editor) => {
			applyCurrentMarkAction(editor, "reject");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("accept-all", "Accept all comments and suggestions", (editor) => {
			applyAllInEditor(editor, "accept");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("reject-all", "Reject all comments and suggestions", (editor) => {
			applyAllInEditor(editor, "reject");
			this.bumpRenderVersion();
		});
		this.addEditorCommand("finalize-for-publish", "Finalize for publish", (editor) => {
			applyAllInEditor(editor, "accept");
			this.bumpRenderVersion();
		});
	}

	private addEditorCommand(
		id: string,
		name: string,
		callback: (editor: Editor) => void | Promise<void>,
		hotkeys?: Hotkey[],
	): void {
		this.addCommand({
			id,
			name,
			hotkeys,
			editorCallback: async (editor) => {
				await callback(editor);
				this.refreshReviewSidebars();
			},
		});
	}

	private registerWorkspaceEvents(): void {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				this.addEditorMenuItems(menu, editor, info);
			}),
		);
		// Canvas node context menu — the event is unofficial but stable.
		this.registerEvent(
			(this.app.workspace as unknown as {
				on(
					name: "canvas:node-menu",
					callback: (
						menu: Menu,
						node: { id: string; canvas?: unknown },
					) => void,
				): EventRef;
			}).on("canvas:node-menu", (menu, node) => {
				menu.addItem((item) => {
					item
						.setTitle("Add comment")
						.setIcon("message-square-plus")
						.onClick(() => {
							// Resolve the view that owns THIS node's canvas: with
							// several canvases open, guessing by active view or
							// first leaf maps the click through the wrong canvas
							// and the pin lands somewhere else entirely.
							const owner = this.app.workspace
								.getLeavesOfType("canvas")
								.find(
									(leaf) =>
										(leaf.view as unknown as { canvas?: unknown })
											.canvas === node.canvas,
								);
							if (owner) {
								this.canvasPins?.addThreadToNode(
									owner.view as never,
									node.id,
								);
							}
						});
				});
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				this.captureActiveMarkdownPath();
				this.hideThreadPreview();
				this.refreshReviewSidebars();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.hideThreadPreview();
				this.queueEditorExtensionRefresh(0);
				// Clicking into the sidebar activates its leaf; rebuilding it
				// for that lands between mousedown and mouseup and swallows
				// the very button press being made (resolve took two clicks).
				// Its content tracks the reviewed note, which hasn't changed.
				if (leaf?.view instanceof ReviewSidebarView) return;
				this.captureActiveContentLeaf(leaf);
				this.captureActiveMarkdownPath();
				this.refreshReviewSidebars();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.captureActiveContentLeaf(this.app.workspace.activeLeaf);
				this.captureActiveMarkdownPath();
				this.hideThreadPreview();
				this.queueEditorExtensionRefresh(0);
				this.refreshReviewSidebars();
				void this.refreshCurrentIdentity();
			}),
		);
	}

	private captureActiveContentLeaf(leaf: WorkspaceLeaf | null): void {
		if (!leaf || leaf.view instanceof ReviewSidebarView) return;
		this.lastContentLeaf = leaf;
		this.observeExternalComments(leaf);
	}

	private getLeafContentRoot(leaf: WorkspaceLeaf): HTMLElement | null {
		const root = (
			leaf.view as typeof leaf.view & { containerEl?: HTMLElement }
		).containerEl;
		return root ?? null;
	}

	private observeExternalComments(leaf: WorkspaceLeaf): void {
		this.externalCommentObserver?.disconnect();
		this.externalCommentObserver = null;
		if (leaf.view instanceof MarkdownView) return;
		const root = this.getLeafContentRoot(leaf);
		if (!root || typeof MutationObserver === "undefined") return;

		this.externalCommentObserver = new MutationObserver(() => {
			this.scheduleExternalCommentRefresh();
		});
		this.externalCommentObserver.observe(root, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: [
				"id",
				"data-criticmarkup-comment",
				"data-criticmarkup-body",
				"data-criticmarkup-author",
				"data-criticmarkup-status",
				"data-criticmarkup-thread",
				"data-criticmarkup-key",
				"data-criticmarkup-target",
				"data-criticmarkup-label",
			],
		});
	}

	private scheduleExternalCommentRefresh(): void {
		if (this.externalCommentRefreshTimer !== null) return;
		this.externalCommentRefreshTimer = window.setTimeout(() => {
			this.externalCommentRefreshTimer = null;
			this.refreshReviewSidebars();
		}, 50);
	}

	private handleIdentityProviderChange(): void {
		this.identityRevision += 1;
		this.identityCache.clear();
		this.settingsTab?.refreshIdentityProviderState();
		this.bumpRenderVersion();
		void this.refreshCurrentIdentity();
	}

	private addEditorMenuItems(
		menu: Menu,
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo,
	): void {
		menu.addSeparator();
		menu.addItem((item) => {
			item
				.setTitle("Add comment")
				.setIcon("message-square-plus")
				.setDisabled(!editor.somethingSelected())
				.onClick(() => {
					this.startCommentDraftFromEditor(editor, info);
				});
		});
	}

	private captureActiveMarkdownPath(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file) {
			this.lastMarkdownPath = view.file.path;
		}
	}

	private getCurrentMarkdownView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file) {
			this.lastContentLeaf = active.leaf;
			this.lastMarkdownPath = active.file.path;
			return active;
		}
		if (this.lastContentLeaf) {
			if (
				this.lastContentLeaf.view instanceof MarkdownView &&
				this.lastContentLeaf.view.file
			) {
				this.lastMarkdownPath = this.lastContentLeaf.view.file.path;
				return this.lastContentLeaf.view;
			}
			return null;
		}
		if (this.lastMarkdownPath) {
			const byPath = this.getMarkdownViewByPath(this.lastMarkdownPath);
			if (byPath) return byPath;
		}
		let fallback: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!fallback && leaf.view instanceof MarkdownView && leaf.view.file) {
				fallback = leaf.view;
			}
		});
		const resolved = fallback as MarkdownView | null;
		if (resolved?.file) {
			this.lastMarkdownPath = resolved.file.path;
		}
		return resolved;
	}

	private getMarkdownViewByPath(path: string): MarkdownView | null {
		let found: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (found) return;
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
				found = leaf.view;
			}
		});
		return found;
	}

	private bumpRenderVersion(): void {
		this.renderVersion += 1;
		this.refreshOpenEditors();
		this.refreshReviewSidebars();
		this.app.workspace.updateOptions();
	}

	private queueEditorExtensionRefresh(delayMs: number): void {
		const timer = window.setTimeout(() => {
			this.app.workspace.updateOptions();
			this.refreshOpenEditors();
		}, delayMs);
		this.register(() => window.clearTimeout(timer));
	}

	private refreshOpenEditors(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const editor = leaf.view.editor;
			const cm = (editor as unknown as { cm?: { dispatch(spec?: object): void } }).cm;
			if (cm?.dispatch) {
				cm.dispatch({});
			} else {
				editor.refresh();
			}
		});
	}
}

function rectFromElement(element: HTMLElement): ClientRectLike {
	const rect = element.getBoundingClientRect();
	return {
		top: rect.top,
		bottom: rect.bottom,
		left: rect.left,
		right: rect.right,
	};
}

function providerIdentity(
	identity: Identity,
	source: IdentityResolverId,
): ReviewerIdentity {
	return {
		...identity,
		source,
	};
}

function sanitizeCommentText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		// Blank lines would split the note into separate Markdown sections
		// around an inline comment; keep single line breaks.
		.replace(/[\t ]*\n[\t ]*\n[\t \n]*/g, "\n")
		// "<<}" inside a comment body would close the mark early.
		.replace(/<<(?=\})/g, "<< ")
		.trim();
}

function fallbackIdentity(): ReviewerIdentity {
	return {
		name: "Unknown author",
		source: "fallback",
	};
}
