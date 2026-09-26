import {
	Component,
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
import { sanitizeCommentText } from "./critic/comment-text";
import { CRITIC_SECTION_SEPARATOR } from "./critic/threading";
import {
	buildReviewRuns,
	reviewAnchorContentFrom,
	reviewAnchorContentTo,
	reviewAnchorFrom,
	reviewAnchorTo,
	type ReviewAnchor,
} from "./critic/review-runs";
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
	refreshReviewEditorUi,
	setCommentDraftAnchor,
	type ReviewEditorController,
} from "./editor/extension";
import {
	isEditorSelectionTrusted,
	type TrustableEditorView,
} from "./editor/selection-trust";
import { matchRenderedAnchor, runsTouching } from "./preview/blocks";
import {
	ADD_COMMENT_HOTKEYS,
	getAddCommentTarget,
} from "./editor/hotkeys";
import { buildCommentDraftInsertion } from "./editor/comment-draft-anchor";
import {
	findCanvasEditorSurface,
	findFocusedCanvasEditorSurface,
	listCanvasEditorSurfaces,
	type CanvasEditorSurface,
	type CanvasViewLike,
} from "./editor/surfaces";
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
import {
	findNativeHighlightAtOffset,
	findNativeHighlightForSelection,
	parseNativeHighlights,
	type NativeHighlight,
} from "./markdown/highlights";

export interface ActiveReviewState {
	file: TFile;
	editor: Editor;
	marks: CriticMark[];
	nativeHighlights: NativeHighlight[];
	activeMarkId: string | null;
	commentDraft: CommentDraft | null;
}

export interface CommentDraft {
	id: number;
	filePath: string;
	from: number;
	to: number;
	selectedText: string;
	nativeHighlight: boolean;
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

interface MarkdownEditorSurface {
	kind: "markdown";
	file: TFile;
	editor: Editor;
	editorView: CodeMirrorEditorView;
	leaf: WorkspaceLeaf;
}

type ReviewEditorSurface = MarkdownEditorSurface | CanvasEditorSurface;

export default class RelayCommentsPlugin
	extends Plugin
	implements ReviewEditorController
{
	settings!: RelayCommentsSettings;
	private commentDraft: CommentDraft | null = null;
	private commentDraftSequence = 0;
	private commentDraftEditorView: CodeMirrorEditorView | null = null;
	private lastReviewEditorView: CodeMirrorEditorView | null = null;
	private lastMarkdownPath: string | null = null;
	private lastContentLeaf: WorkspaceLeaf | null = null;
	private externalCommentObserver: MutationObserver | null = null;
	private externalCommentRefreshTimer: number | null = null;
	private reviewSidebarOpenPromise: Promise<void> | null = null;
	private sidebarRefreshTimer: number | null = null;
	private identityRefreshTimer: number | null = null;
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
		// Reading view has no editor anchors; its highlights are matched by what they show.
		this.registerDomEvent(document, "click", (event) => {
			this.handlePreviewAnchorClick(event);
		});
		this.registerDomEvent(document, "pointerover", (event) => {
			this.handlePreviewAnchorHover(event);
		});
		this.registerDomEvent(document, "pointerout", (event) => {
			const target = event.target as HTMLElement | null;
			const highlight = this.previewAnchorAt(target);
			if (!highlight) return;
			const related = event.relatedTarget as Node | null;
			if (related && highlight.contains(related)) return;
			this.scheduleThreadPreviewDismiss();
		});

		this.registerCommands();
		this.registerWorkspaceEvents();
		this.captureActiveContentLeaf(
			this.app.workspace.getActiveViewOfType(ItemView)?.leaf ?? null,
		);
		for (const provider of this.identityProviders) {
			if (provider.subscribe) {
				this.register(
					provider.subscribe(() => this.handleIdentityProviderChange()),
				);
			}
		}
		void this.refreshCurrentIdentity();

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
			this.captureActiveContentLeaf(
				this.app.workspace.getActiveViewOfType(ItemView)?.leaf ?? null,
			);
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
		if (this.sidebarRefreshTimer !== null) {
			window.clearTimeout(this.sidebarRefreshTimer);
			this.sidebarRefreshTimer = null;
		}
		if (this.identityRefreshTimer !== null) {
			window.clearTimeout(this.identityRefreshTimer);
			this.identityRefreshTimer = null;
		}
		this.hideThreadPreview();
		this.editorExtensions.length = 0;
		this.app.workspace.updateOptions();
	}

	/** The Reading-view comment highlight under a pointer target, if any. */
	private previewAnchorAt(target: HTMLElement | null): HTMLElement | null {
		const highlight = target?.closest<HTMLElement>(
			".markdown-preview-view .critic-preview-highlight",
		);
		return highlight && highlight.dataset.criticFrom === undefined
			? highlight
			: null;
	}

	/** The review run a Reading-view highlight stands for; ambiguous matches resolve to nothing. */
	private resolvePreviewAnchor(
		highlight: HTMLElement,
	): { path: string; from: number; to: number } | null {
		let view: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (
				!view &&
				leaf.view instanceof MarkdownView &&
				leaf.view.containerEl.contains(highlight)
			) {
				view = leaf.view;
			}
		});
		const markdownView = view as MarkdownView | null;
		if (!markdownView?.file) return null;
		const text = markdownView.editor?.getValue() ?? markdownView.data;
		const marks = parseCriticMarkup(text);
		const match = matchRenderedAnchor(
			text,
			runsTouching(text, marks, 0, text.length),
			marks,
			highlight.textContent ?? "",
			highlight.getAttribute("title"),
		);
		return match ? { path: markdownView.file.path, ...match } : null;
	}

	/** A click on a comment highlight in Reading view opens its thread. */
	private handlePreviewAnchorClick(event: MouseEvent): void {
		const highlight = this.previewAnchorAt(event.target as HTMLElement | null);
		if (!highlight) return;
		const anchor = this.resolvePreviewAnchor(highlight);
		if (!anchor) return;
		event.preventDefault();
		this.activateCommentThread(anchor.path, anchor.from, anchor.to);
	}

	/** Resting on a comment highlight in Reading view previews its thread. */
	private handlePreviewAnchorHover(event: PointerEvent): void {
		if (event.buttons !== 0) return;
		const highlight = this.previewAnchorAt(event.target as HTMLElement | null);
		if (!highlight) return;
		const anchor = this.resolvePreviewAnchor(highlight);
		if (!anchor) return;
		// The native tooltip would double the preview.
		highlight.removeAttribute("title");
		this.queueThreadPreview(anchor.path, anchor.from, anchor.to, highlight);
	}

	notifyEditorSelectionChanged(editorView?: CodeMirrorEditorView): void {
		if (editorView) this.rememberReviewEditor(editorView);
		this.scheduleReviewSidebarRefresh(120);
	}

	notifyRenderedCommentsChanged(): void {
		this.scheduleExternalCommentRefresh();
	}

	resolveEditorPath(
		editorView: CodeMirrorEditorView,
		path: string | null,
	): string | null {
		const surface = this.findReviewEditorSurface(editorView);
		if (surface) {
			this.rememberReviewEditorSurface(surface);
			return surface.file.path;
		}
		return path;
	}

	getDisplayMode(path?: string | null): DisplayMode {
		return "review";
	}

	shouldShowInlineActions(): boolean {
		return this.settings.showInlineActions;
	}

	activateCommentThread(
		path: string | null,
		from: number,
		to: number,
		options?: {
			focusReply?: boolean;
			editorView?: CodeMirrorEditorView;
		},
	): void {
		// The thread is opening where the preview points; keep both around
		// and they compete for the same attention.
		this.hideThreadPreview();
		if (options?.editorView) this.rememberReviewEditor(options.editorView);
		const filePath =
			options?.editorView
				? this.findReviewEditorSurface(options.editorView)?.file.path ?? path
				: path ?? this.app.workspace.getActiveFile()?.path ?? null;
		if (filePath) {
			this.lastMarkdownPath = filePath;
		}

		const activate = (leaf: WorkspaceLeaf | undefined) => {
			if (leaf?.view instanceof ReviewSidebarView) {
				leaf.view.activateThreadForRange(from, to, {
					focusReply: options?.focusReply,
				});
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
		editorView?: CodeMirrorEditorView,
	): void {
		if (!this.settings.showHoverPreview) return;
		if (editorView) this.rememberReviewEditor(editorView);
		const active = document.activeElement;
		if (
			active instanceof HTMLTextAreaElement &&
			active.closest(".critic-sidebar")
		) {
			return;
		}
		const filePath =
			(editorView
				? this.findReviewEditorSurface(editorView)?.file.path
				: null) ?? path ?? this.app.workspace.getActiveFile()?.path ?? null;
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
				editorView,
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
			editorView?: CodeMirrorEditorView;
		},
	): boolean {
		if (options.editorView) this.rememberReviewEditor(options.editorView);
		const data = this.buildThreadPreviewData(
			filePath,
			from,
			to,
			options.editorView,
		);
		if (!data) return false;
		this.hideThreadPreview();
		const renderScope = new Component();
		renderScope.load();

		const element = this.renderThreadPreview(
			data,
			options.role,
			{
				open: (opts) =>
					this.activateCommentThread(filePath, from, to, {
						...opts,
						editorView: options.editorView,
					}),
				resolve: () => {
					this.hideThreadPreview();
					this.resolveThreadAtRange(
						filePath,
						from,
						to,
						options.editorView,
					);
				},
				apply: (action) => {
					this.hideThreadPreview();
					this.applySuggestionActionAtRange(
						filePath,
						from,
						to,
						action,
						options.editorView,
					);
				},
			},
			renderScope,
		);
		const ownerDocument = options.anchor?.ownerDocument ?? document;
		const ownerWindow = ownerDocument.defaultView ?? window;
		ownerDocument.body.appendChild(element);
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
		ownerDocument.addEventListener("pointerdown", onDocumentPointerDown, true);
		ownerDocument.addEventListener("keydown", onDocumentKeyDown, true);
		ownerDocument.addEventListener("scroll", onScroll, true);
		ownerWindow.addEventListener("resize", onResize);

		this.activeThreadPreview = {
			element,
			anchor: options.anchor,
			originalTitle: previousTitle,
			originalAriaDescribedBy: previousDescribedBy,
			returnFocus: options.returnFocus,
			cleanup: () => {
				renderScope.unload();
				element.removeEventListener("pointerenter", cancelDismiss);
				element.removeEventListener("pointerleave", onPointerLeave);
				ownerDocument.removeEventListener(
					"pointerdown",
					onDocumentPointerDown,
					true,
				);
				ownerDocument.removeEventListener("keydown", onDocumentKeyDown, true);
				ownerDocument.removeEventListener("scroll", onScroll, true);
				ownerWindow.removeEventListener("resize", onResize);
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
		renderScope: Component,
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
		const element = createDiv();
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
				component: renderScope,
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
		const ownerWindow = element.ownerDocument.defaultView ?? window;
		const margin = 12;
		const gap = 8;
		const width = Math.min(
			360,
			Math.max(280, ownerWindow.innerWidth - margin * 2),
		);
		element.setCssStyles({ width: `${width}px` });
		const previewRect = element.getBoundingClientRect();
		let left = anchorRect.left;
		if (left + width > ownerWindow.innerWidth - margin) {
			left = ownerWindow.innerWidth - width - margin;
		}
		left = Math.max(margin, left);

		let top = anchorRect.bottom + gap;
		let placedAbove = false;
		if (top + previewRect.height > ownerWindow.innerHeight - margin) {
			top = anchorRect.top - previewRect.height - gap;
			placedAbove = true;
		}
		top = Math.max(margin, top);
		element.setCssStyles({
			left: `${Math.round(left)}px`,
			top: `${Math.round(top)}px`,
		});
		// The caret pins the popover to its anchor: aim it at the anchor's
		// horizontal center, kept clear of the rounded corners.
		const caretX = Math.min(
			width - 18,
			Math.max(18, anchorRect.left + (anchorRect.right - anchorRect.left) / 2 - left),
		);
		element.setCssProps({
			"--critic-preview-caret-x": `${Math.round(caretX)}px`,
		});
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
		const snapshot = this.resolveCurrentIdentitySnapshot(filePath);
		if (snapshot !== undefined) {
			this.identityCache.set(key, snapshot);
			return snapshot ?? fallbackIdentity();
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
		const snapshot = this.resolveAuthorIdentitySnapshot(
			author,
			resolvedFilePath,
		);
		if (snapshot !== undefined) {
			this.identityCache.set(key, snapshot);
			return (
				snapshot ?? {
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
		editorView?: CodeMirrorEditorView,
	): {
		anchor: ReviewAnchor;
		visibleComments: CriticMark[];
		runFrom: number;
		runTo: number;
	} | null {
		const surface = editorView
			? this.findReviewEditorSurface(editorView)
			: this.findReviewEditorSurfaceByPath(filePath);
		const editor = surface?.editor;
		if (!surface || surface.file.path !== filePath || !editor) return null;
		const text = editor.getValue();
		const marks = parseCriticMarkup(text);
		const nativeHighlights = parseNativeHighlights(text, marks);

		for (const run of buildReviewRuns(text, marks, nativeHighlights)) {
			if (
				reviewAnchorFrom(run.anchor) !== from ||
				reviewAnchorTo(run.anchor) !== to
			) {
				continue;
			}
			return {
				anchor: run.anchor,
				visibleComments: run.comments.filter(
					(comment) => comment.content.trim().length > 0,
				),
				runFrom: run.from,
				runTo: run.to,
			};
		}
		return null;
	}

	private buildThreadPreviewData(
		filePath: string,
		from: number,
		to: number,
		editorView?: CodeMirrorEditorView,
	): ThreadPreviewData | null {
		const found = this.findMarkRunAtRange(filePath, from, to, editorView);
		if (!found) return null;
		const { anchor, visibleComments } = found;

		if (visibleComments.length === 0) {
			if (anchor.kind !== "critic") return null;
			const parts = getSuggestionPreviewParts(anchor.mark);
			if (!parts) return null;
			const identity = this.getReviewerIdentityForMark(anchor.mark, filePath);
			return {
				kind: "suggestion",
				label: parts.label,
				countLabel: "",
				snippet: clampPreviewSnippet(parts.snippet),
				sourcePath: filePath,
				moreLabel: null,
				author: identity.source === "fallback" ? null : identity.name,
				date: formatMarkDate(anchor.mark),
				resolved: false,
			};
		}

		const firstComment = visibleComments[0];
		const identity = this.getReviewerIdentityForMark(firstComment, filePath);
		const resolved = [
			...(anchor.kind === "critic" ? [anchor.mark] : []),
			...visibleComments,
		].some(
			(candidate) => candidate.metadata?.resolved === "true",
		);
		return {
			kind: "thread",
			label: resolved
				? "Resolved comment"
				: anchor.kind === "critic" && isSuggestionMark(anchor.mark)
					? "Comment on suggestion"
					: "Comment",
			countLabel:
				visibleComments.length > 1
					? `${visibleComments.length} comments`
					: "",
			// Keep the Markdown source intact. CSS clamps the rendered preview;
			// truncating first can split a link, code fence, or emphasis marker.
			snippet: firstComment.content,
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
	resolveThreadAtRange(
		filePath: string,
		from: number,
		to: number,
		editorView?: CodeMirrorEditorView,
	): void {
		if (editorView) this.rememberReviewEditor(editorView);
		const found = this.findMarkRunAtRange(filePath, from, to, editorView);
		if (!found || found.visibleComments.length === 0) return;
		const { anchor, runFrom, runTo } = found;
		if (anchor.kind === "native-highlight") {
			this.replaceReviewRangeFromSidebar(anchor.highlight.to, runTo, "");
		} else if (anchor.mark.type === "comment") {
			this.replaceReviewRangeFromSidebar(runFrom, runTo, "");
		} else if (isSuggestionMark(anchor.mark)) {
			this.replaceReviewRangeFromSidebar(anchor.mark.to, runTo, "");
		} else {
			this.replaceReviewRangeFromSidebar(
				runFrom,
				runTo,
				replacementForMark(anchor.mark, "accept"),
			);
		}
		this.refreshReviewSidebars();
	}

	applySuggestionActionAtRange(
		filePath: string,
		from: number,
		to: number,
		action: CriticAction,
		editorView?: CodeMirrorEditorView,
	): void {
		if (editorView) this.rememberReviewEditor(editorView);
		const found = this.findMarkRunAtRange(filePath, from, to, editorView);
		if (
			!found ||
			found.anchor.kind !== "critic" ||
			!isSuggestionMark(found.anchor.mark)
		) {
			return;
		}
		if (found.visibleComments.length > 0) {
			this.replaceReviewRangeFromSidebar(
				found.runFrom,
				found.runTo,
				replacementForMark(found.anchor.mark, action),
			);
			this.refreshReviewSidebars();
		} else {
			this.applyMarkActionFromSidebar(found.anchor.mark, action);
		}
	}

	private showCommentPreviewAtCursor(editor: Editor): void {
		const editorView = this.getCodeMirrorEditor(
			editor,
		) as CodeMirrorEditorView | null;
		const surface = editorView
			? this.findReviewEditorSurface(editorView)
			: this.getCurrentReviewEditorSurface();
		const file = surface?.file;
		if (!file) {
			new Notice("Open a Markdown note to preview comments.");
			return;
		}
		const text = editor.getValue();
		const marks = parseCriticMarkup(text);
		const mark = getCurrentMark(editor);
		const cursorOffset = editor.posToOffset(editor.getCursor("from"));
		const nativeHighlight = findNativeHighlightAtOffset(
			parseNativeHighlights(text, marks),
			cursorOffset,
		);
		const reviewAnchor: ReviewAnchor | null = mark?.valid
			? { kind: "critic", mark }
			: nativeHighlight
				? { kind: "native-highlight", highlight: nativeHighlight }
				: null;
		if (!reviewAnchor) {
			new Notice("No comment thread at the cursor.");
			return;
		}
		const cm = this.getCodeMirrorEditor(editor);
		const anchor = cm
			? this.getRenderedRangeElement(
					cm,
					reviewAnchorFrom(reviewAnchor),
					reviewAnchorTo(reviewAnchor),
				)
			: null;
		const rect =
			anchor?.getBoundingClientRect() ??
			this.getEditorOffsetRect(
				editor,
				reviewAnchorContentFrom(reviewAnchor),
				reviewAnchorContentTo(reviewAnchor),
				cm,
			);
		if (!rect) {
			new Notice("No visible comment anchor at the cursor.");
			return;
		}
		const shown = this.showThreadPreview(
			file.path,
			reviewAnchorFrom(reviewAnchor),
			reviewAnchorTo(reviewAnchor),
			rect,
			{
				anchor,
				returnFocus: () => editor.focus(),
				role: "dialog",
				editorView: editorView ?? undefined,
			},
		);
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

	async saveSettingsAndRefresh(
		options: { editorUi?: boolean } = {},
	): Promise<void> {
		await this.saveData(this.settings);
		this.identityRevision += 1;
		this.identityCache.clear();
		void this.refreshCurrentIdentity();
		if (options.editorUi) this.refreshOpenEditorUi();
		this.refreshReviewSidebars();
	}

	async onExternalSettingsChange(): Promise<void> {
		const previousInlineActions = this.settings.showInlineActions;
		await this.loadSettings();
		this.identityRevision += 1;
		this.identityCache.clear();
		this.settingsTab?.refreshIdentityProviderState();
		void this.refreshCurrentIdentity();
		if (this.settings.showInlineActions !== previousInlineActions) {
			this.refreshOpenEditorUi();
		}
		this.refreshReviewSidebars();
	}

	getActiveReviewState(): ActiveReviewState | null {
		const surface = this.getCurrentReviewEditorSurface();
		const file = surface?.file;
		const editor = surface?.editor;
		if (!file || !editor) return null;

		const text = editor.getValue();
		const marks = parseCriticMarkup(text);
		const nativeHighlights = parseNativeHighlights(text, marks);
		const activeMark = getCurrentMark(editor);
		const cursorOffset = editor.posToOffset(editor.getCursor("from"));
		const activeNativeHighlight = findNativeHighlightAtOffset(
			nativeHighlights,
			cursorOffset,
		);
		return {
			file,
			editor,
			marks,
			nativeHighlights,
			activeMarkId: activeMark?.id ?? activeNativeHighlight?.id ?? null,
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
		editorView?: CodeMirrorEditorView,
	): void {
		const surface = editorView
			? this.findReviewEditorSurface(editorView)
			: path
				? this.findReviewEditorSurfaceByPath(path)
				: this.getCurrentReviewEditorSurface();
		if (surface) this.rememberReviewEditorSurface(surface);
		const activeFile = this.app.workspace.getActiveFile();
		const filePath = surface?.file.path ?? path ?? activeFile?.path;
		if (!filePath) {
			new Notice("Open a Markdown note before adding a comment.");
			return;
		}
		// CriticMarkup can't express overlapping marks.
		const editorText = surface?.editor.getValue();
		const marks = editorText ? parseCriticMarkup(editorText) : [];
		if (
			editorText &&
			marks.some(
				(mark) => mark.from < to && mark.to > from,
			)
		) {
			new Notice(
				"That selection already contains a suggestion or comment.",
			);
			return;
		}
		const nativeHighlights = editorText
			? parseNativeHighlights(editorText, marks)
			: [];
		const nativeHighlight = findNativeHighlightForSelection(
			nativeHighlights,
			from,
			to,
		);
		const overlappingNativeHighlight = nativeHighlights.some(
			(highlight) => highlight.from < to && highlight.to > from,
		);
		if (overlappingNativeHighlight && !nativeHighlight) {
			new Notice("Select the entire highlighted passage to comment on it.");
			return;
		}
		if (nativeHighlight) {
			from = nativeHighlight.contentFrom;
			to = nativeHighlight.contentTo;
			selectedText = nativeHighlight.text;
		}
		this.lastMarkdownPath = filePath;
		this.clearCommentDraftAnchor();
		const draft: CommentDraft = {
			id: ++this.commentDraftSequence,
			filePath,
			from,
			to,
			selectedText,
			nativeHighlight: nativeHighlight !== null,
		};
		this.commentDraft = draft;
		this.commentDraftEditorView = surface?.editorView ?? editorView ?? null;
		this.commentDraftEditorView?.dispatch({
			effects: setCommentDraftAnchor.of({ id: draft.id, filePath, from, to }),
		});
		void this.openReviewSidebar();
		this.refreshReviewSidebars();
	}

	updateCommentDraftAnchor(
		id: number,
		filePath: string,
		from: number,
		to: number,
		selectedText: string,
	): void {
		const draft = this.commentDraft;
		if (!draft || draft.id !== id || draft.filePath !== filePath) return;
		draft.from = from;
		draft.to = to;
		draft.selectedText = selectedText;
		this.scheduleReviewSidebarRefresh(100);
	}

	startCommentDraftFromEditor(
		editor: Editor,
		info?: { file?: TFile | null },
	): void {
		// A widget selection leaves the editor reporting a stale range.
		const cm = this.getCodeMirrorEditor(editor) as unknown as
			| TrustableEditorView
			| null;
		if (cm?.contentDOM && cm.state && !isEditorSelectionTrusted(cm)) {
			new Notice(
				"Can't comment on text inside a rendered block. Open the block for editing and select the text there.",
			);
			return;
		}
		const fromPos = editor.getCursor("from");
		const toPos = editor.getCursor("to");
		const from = editor.posToOffset(fromPos);
		const to = editor.posToOffset(toPos);
		const selectedText = editor.getSelection();
		if (from === to || selectedText.length === 0) {
			new Notice("Select text to comment on.");
			return;
		}
		this.startCommentDraft(
			info?.file?.path ?? null,
			from,
			to,
			selectedText,
			(this.getCodeMirrorEditor(editor) as CodeMirrorEditorView | null) ??
				undefined,
		);
	}

	async commitCommentDraft(comment: string): Promise<void> {
		if (!this.commentDraft) return;
		const draft = this.commentDraft;
		const initiatingEditorView = this.commentDraftEditorView;
		const surface = initiatingEditorView
			? this.findReviewEditorSurface(initiatingEditorView) ??
				this.findReviewEditorSurfaceByPath(draft.filePath)
			: this.findReviewEditorSurfaceByPath(draft.filePath);
		if (!surface || surface.file.path !== draft.filePath) {
			new Notice("Open the commented note before saving this comment.");
			return;
		}
		const identity = await this.getCurrentReviewerIdentityAsync(draft.filePath);
		// Identity lookup may involve the network. Recheck that the same draft
		// and editor are still active before applying its source edit.
		if (this.commentDraft !== draft) return;
		const refreshedSurface = initiatingEditorView
			? this.findReviewEditorSurface(initiatingEditorView) ??
				this.findReviewEditorSurfaceByPath(draft.filePath)
			: this.findReviewEditorSurfaceByPath(draft.filePath);
		const refreshedEditor = refreshedSurface?.editor;
		if (!refreshedEditor || refreshedSurface.file.path !== draft.filePath) {
			new Notice("Open the commented note before saving this comment.");
			return;
		}
		const documentText = refreshedEditor.getValue();
		const commentMarkup = this.formatAttachedCommentMarkup(comment, identity);
		const marks = parseCriticMarkup(documentText);
		const nativeHighlights = parseNativeHighlights(documentText, marks);
		const nativeHighlight = draft.nativeHighlight
			? findNativeHighlightForSelection(
					nativeHighlights,
					draft.from,
					draft.to,
				)
			: null;
		this.commentDraft = null;
		this.clearCommentDraftAnchor();
		if (nativeHighlight) {
			const run = buildReviewRuns(
				documentText,
				marks,
				nativeHighlights,
			).find(
				(candidate) =>
					candidate.anchor.kind === "native-highlight" &&
					candidate.anchor.highlight.id === nativeHighlight.id,
			);
			const insertionOffset = run?.to ?? nativeHighlight.to;
			refreshedEditor.replaceRange(
				commentMarkup,
				refreshedEditor.offsetToPos(insertionOffset),
				undefined,
				"relay-comments",
			);
		} else {
			const currentText = documentText.slice(draft.from, draft.to);
			const insertion = buildCommentDraftInsertion(currentText, commentMarkup);
			refreshedEditor.replaceRange(
				insertion,
				refreshedEditor.offsetToPos(draft.from),
				refreshedEditor.offsetToPos(draft.to),
				"relay-comments",
			);
		}
		this.refreshReviewSidebars();
	}

	cancelCommentDraft(): void {
		this.commentDraft = null;
		this.clearCommentDraftAnchor();
		this.refreshReviewSidebars();
	}

	private clearCommentDraftAnchor(): void {
		const editorView = this.commentDraftEditorView;
		this.commentDraftEditorView = null;
		if (!editorView?.dom.isConnected) return;
		editorView.dispatch({ effects: setCommentDraftAnchor.of(null) });
	}

	locateMark(mark: CriticMark): void {
		this.locateReviewRange(mark.from, mark.to);
	}

	locateReviewRange(
		fromOffset: number,
		toOffset: number,
		options: { focusEditor?: boolean; select?: boolean } = {},
	): void {
		const surface = this.getCurrentReviewEditorSurface();
		const editor = surface?.editor;
		if (!editor) return;
		this.revealReviewEditorSurface(surface);

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
		const editor = this.getCurrentReviewEditorSurface()?.editor;
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
		this.refreshReviewSidebars();
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

	private resolveCurrentIdentitySnapshot(
		path: string,
	): ReviewerIdentity | null | undefined {
		const provider = this.getSelectedIdentityProvider();
		if (!provider) return this.getLocalReviewerIdentity();
		if (!provider.getCurrentUserSnapshot) return undefined;
		try {
			const identity = provider.getCurrentUserSnapshot(path);
			return identity ? providerIdentity(identity, provider.id) : null;
		} catch {
			return undefined;
		}
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

	private resolveAuthorIdentitySnapshot(
		author: string,
		path: string,
	): ReviewerIdentity | null | undefined {
		const provider = this.getSelectedIdentityProvider();
		const resolvers: IdentityResolver[] = [
			...(provider ? [provider] : []),
			this.configuredIdentityResolver,
		];
		for (const resolver of resolvers) {
			if (!resolver.isAvailable()) continue;
			if (!resolver.resolveUserSnapshot) return undefined;
			try {
				const identity = resolver.resolveUserSnapshot(author, path);
				if (identity) return providerIdentity(identity, resolver.id);
			} catch {
				return undefined;
			}
		}
		const local = this.getLocalReviewerIdentity();
		return local?.id === author ? local : null;
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
				this.scheduleIdentityRefresh();
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
		const editor = this.getCurrentReviewEditorSurface()?.editor;
		if (!editor) return;
		replaceMark(editor, mark, action);
		this.refreshReviewSidebars();
	}

	replaceReviewRangeFromSidebar(
		fromOffset: number,
		toOffset: number,
		replacement: string,
	): void {
		const editor = this.getCurrentReviewEditorSurface()?.editor;
		if (!editor) return;
		editor.replaceRange(
			replacement,
			editor.offsetToPos(fromOffset),
			editor.offsetToPos(toOffset),
			"relay-comments",
		);
		this.refreshReviewSidebars();
	}

	async insertReplyToMark(
		mark: CriticMark | NativeHighlight,
		reply: string,
	): Promise<boolean> {
		const surface = this.getCurrentReviewEditorSurface();
		const editor = surface?.editor;
		const path = surface?.file.path;
		if (!editor || !path) return false;
		const editorView = surface.editorView;
		const identity = await this.getCurrentReviewerIdentityAsync(path);
		const refreshedSurface =
			this.findReviewEditorSurface(editorView) ??
			this.findReviewEditorSurfaceByPath(path);
		const refreshedEditor = refreshedSurface?.editor;
		if (!refreshedEditor || refreshedSurface.file.path !== path) return false;
		this.rememberReviewEditorSurface(refreshedSurface);
		const cm = this.getCodeMirrorEditor(refreshedEditor);
		const scrollTop = cm?.scrollDOM?.scrollTop;
		refreshedEditor.replaceRange(
			this.formatAttachedCommentMarkup(reply, identity),
			refreshedEditor.offsetToPos(mark.to),
			undefined,
			"relay-comments",
		);
		this.refreshReviewSidebars();
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
		const editor = this.getCurrentReviewEditorSurface()?.editor;
		if (!editor) return false;
		const range = mark.ranges.commentText ?? [mark.contentFrom, mark.contentTo];
		editor.replaceRange(
			sanitizeCommentText(text),
			editor.offsetToPos(range[0]),
			editor.offsetToPos(range[1]),
			"relay-comments",
		);
		this.refreshReviewSidebars();
		return true;
	}

	private formatCommentMarkup(
		comment: string,
		identity: ReviewerIdentity,
	): string {
		const content = sanitizeCommentText(comment);
		return formatAuthoredComment(
			content,
			identity.id,
			identity.source === "fallback" ? undefined : identity.name,
		);
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
		return (
			this.app.workspace.getActiveViewOfType(ReviewSidebarView)?.leaf === leaf &&
			rightSplit?.collapsed !== true
		);
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
		if (this.sidebarRefreshTimer !== null) {
			window.clearTimeout(this.sidebarRefreshTimer);
			this.sidebarRefreshTimer = null;
		}
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
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(ItemView);
				if (view?.getViewType() !== "canvas") return false;
				if (!checking) this.canvasPins?.beginPlacement(view);
				return true;
			},
		});
		this.addCommand({
			id: "add-comment",
			name: "Add comment",
			hotkeys: ADD_COMMENT_HOTKEYS,
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(ItemView);
				const target = getAddCommentTarget(view?.getViewType());
				if (target === "canvas") {
					const canvasEditor = this.findFocusedCanvasEditorSurface(
						view as unknown as CanvasViewLike,
					);
					if (canvasEditor) {
						if (!checking) {
							this.rememberReviewEditorSurface(canvasEditor);
							this.startCommentDraftFromEditor(
								canvasEditor.editor,
								{ file: canvasEditor.file },
							);
						}
						return true;
					}
					if (!checking && view) this.canvasPins?.beginPlacement(view);
					return true;
				}
				if (target !== "markdown" || !(view instanceof MarkdownView)) {
					return false;
				}
				if (!checking) {
					this.startCommentDraftFromEditor(view.editor, view);
					this.refreshReviewSidebars();
				}
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
		this.addEditorCommand("add-highlight", "Highlight selection", (editor) =>
			wrapSelection(editor, "highlight"),
		);
		this.addEditorCommand("accept-current", "Accept current comment or suggestion", (editor) => {
			applyCurrentMarkAction(editor, "accept");
		});
		this.addEditorCommand("reject-current", "Reject current comment or suggestion", (editor) => {
			applyCurrentMarkAction(editor, "reject");
		});
		this.addEditorCommand("accept-all", "Accept all comments and suggestions", (editor) => {
			applyAllInEditor(editor, "accept");
		});
		this.addEditorCommand("reject-all", "Reject all comments and suggestions", (editor) => {
			applyAllInEditor(editor, "reject");
		});
		this.addEditorCommand("finalize-for-publish", "Finalize for publish", (editor) => {
			applyAllInEditor(editor, "accept");
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
								this.canvasPins?.addThreadToNode(owner.view, node.id);
							}
						});
				});
			}),
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => {
				this.captureActiveMarkdownPath();
				this.hideThreadPreview();
				this.scheduleReviewSidebarRefresh(100);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.hideThreadPreview();
				// Clicking into the sidebar activates its leaf; rebuilding it
				// for that lands between mousedown and mouseup and swallows
				// the very button press being made (resolve took two clicks).
				// Its content tracks the reviewed note, which hasn't changed.
				if (leaf?.view instanceof ReviewSidebarView) return;
				this.captureActiveContentLeaf(leaf);
				this.captureActiveMarkdownPath();
				this.scheduleReviewSidebarRefresh(0);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.captureActiveContentLeaf(
					this.app.workspace.getActiveViewOfType(ItemView)?.leaf ?? null,
				);
				this.captureActiveMarkdownPath();
				this.hideThreadPreview();
				this.scheduleReviewSidebarRefresh(0);
				void this.refreshCurrentIdentity();
			}),
		);
	}

	private captureActiveContentLeaf(leaf: WorkspaceLeaf | null): void {
		if (!leaf || leaf.view instanceof ReviewSidebarView) return;
		if (this.lastReviewEditorView) {
			const surface = this.findReviewEditorSurface(this.lastReviewEditorView);
			if (surface && surface.leaf !== leaf) {
				this.lastReviewEditorView = null;
			}
		}
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

	private scheduleReviewSidebarRefresh(delayMs: number): void {
		if (this.sidebarRefreshTimer !== null) {
			window.clearTimeout(this.sidebarRefreshTimer);
		}
		this.sidebarRefreshTimer = window.setTimeout(() => {
			this.sidebarRefreshTimer = null;
			this.refreshReviewSidebars();
		}, delayMs);
	}

	private scheduleIdentityRefresh(): void {
		if (this.identityRefreshTimer !== null) {
			window.clearTimeout(this.identityRefreshTimer);
		}
		this.identityRefreshTimer = window.setTimeout(() => {
			this.identityRefreshTimer = null;
			this.refreshReviewSidebars();
		}, 50);
	}

	private handleIdentityProviderChange(): void {
		this.identityRevision += 1;
		this.identityCache.clear();
		this.settingsTab?.refreshIdentityProviderState();
		this.refreshReviewSidebars();
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

	private canvasLeaves(): WorkspaceLeaf[] {
		return this.app.workspace.getLeavesOfType("canvas");
	}

	private findFocusedCanvasEditorSurface(
		view?: CanvasViewLike | null,
	): CanvasEditorSurface | null {
		return findFocusedCanvasEditorSurface(this.canvasLeaves(), view);
	}

	private findReviewEditorSurface(
		editorView: CodeMirrorEditorView,
	): ReviewEditorSurface | null {
		let markdown: MarkdownEditorSurface | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (markdown || !(leaf.view instanceof MarkdownView) || !leaf.view.file) {
				return;
			}
			if (this.getCodeMirrorEditor(leaf.view.editor) !== editorView) return;
			markdown = {
				kind: "markdown",
				file: leaf.view.file,
				editor: leaf.view.editor,
				editorView,
				leaf,
			};
		});
		return (
			markdown ??
			findCanvasEditorSurface(this.canvasLeaves(), editorView)
		);
	}

	private findReviewEditorSurfaceByPath(
		path: string,
	): ReviewEditorSurface | null {
		if (this.lastReviewEditorView) {
			const remembered = this.findReviewEditorSurface(this.lastReviewEditorView);
			if (remembered?.file.path === path) return remembered;
		}

		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file?.path === path) {
			const editorView = this.getCodeMirrorEditor(
				active.editor,
			) as CodeMirrorEditorView | null;
			if (editorView) {
				return {
					kind: "markdown",
					file: active.file,
					editor: active.editor,
					editorView,
					leaf: active.leaf,
				};
			}
		}

		const markdown = this.getMarkdownViewByPath(path);
		if (markdown?.file) {
			const editorView = this.getCodeMirrorEditor(
				markdown.editor,
			) as CodeMirrorEditorView | null;
			if (editorView) {
				return {
					kind: "markdown",
					file: markdown.file,
					editor: markdown.editor,
					editorView,
					leaf: markdown.leaf,
				};
			}
		}

		return (
			listCanvasEditorSurfaces(this.canvasLeaves()).find(
				(surface) => surface.file.path === path,
			) ?? null
		);
	}

	private rememberReviewEditor(editorView: CodeMirrorEditorView): void {
		const surface = this.findReviewEditorSurface(editorView);
		if (surface) this.rememberReviewEditorSurface(surface);
	}

	private rememberReviewEditorSurface(surface: ReviewEditorSurface): void {
		this.lastReviewEditorView = surface.editorView;
		this.lastMarkdownPath = surface.file.path;
		this.lastContentLeaf = surface.leaf;
	}

	private getCurrentReviewEditorSurface(): ReviewEditorSurface | null {
		const activeMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeMarkdown?.file) {
			const editorView = this.getCodeMirrorEditor(
				activeMarkdown.editor,
			) as CodeMirrorEditorView | null;
			if (editorView) {
				const surface: MarkdownEditorSurface = {
					kind: "markdown",
					file: activeMarkdown.file,
					editor: activeMarkdown.editor,
					editorView,
					leaf: activeMarkdown.leaf,
				};
				this.rememberReviewEditorSurface(surface);
				return surface;
			}
		}

		const focusedCanvasEditor = this.findFocusedCanvasEditorSurface(
			this.lastContentLeaf?.view as unknown as CanvasViewLike,
		);
		if (focusedCanvasEditor) {
			this.rememberReviewEditorSurface(focusedCanvasEditor);
			return focusedCanvasEditor;
		}

		if (this.lastReviewEditorView) {
			const remembered = this.findReviewEditorSurface(this.lastReviewEditorView);
			if (remembered && remembered.leaf === this.lastContentLeaf) {
				return remembered;
			}
		}

		if (
			this.lastMarkdownPath &&
			(!this.lastContentLeaf || this.lastContentLeaf.view instanceof MarkdownView)
		) {
			return this.findReviewEditorSurfaceByPath(this.lastMarkdownPath);
		}
		return null;
	}

	private revealReviewEditorSurface(surface: ReviewEditorSurface): void {
		if (surface.kind === "markdown") return;
		try {
			surface.canvas.selectOnly?.(surface.node);
			surface.canvas.zoomToSelection?.();
		} catch {
			// Canvas internals are unofficial. CM6 scrolling below still works
			// when Obsidian changes or omits these convenience methods.
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

	private refreshOpenEditorUi(): void {
		const refreshed = new Set<CodeMirrorAdapter>();
		const refresh = (editor: Editor) => {
			const cm = this.getCodeMirrorEditor(editor);
			if (!cm || refreshed.has(cm)) return;
			refreshed.add(cm);
			cm.dispatch({ effects: refreshReviewEditorUi.of(null) });
		};
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			refresh(leaf.view.editor);
		});
		for (const surface of listCanvasEditorSurfaces(this.canvasLeaves())) {
			refresh(surface.editor);
		}
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

function fallbackIdentity(): ReviewerIdentity {
	return {
		name: "Unknown author",
		source: "fallback",
	};
}
