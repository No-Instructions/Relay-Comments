import { Menu, Platform, setIcon, setTooltip, type WorkspaceLeaf } from "obsidian";
import {
	formatComposerSubmitHint,
	isComposerSubmitKey,
} from "../ui/composer-keys";
import {
	addReply,
	authorInitials,
	createThread,
	formatCommentDate,
	isEmptyCarrier,
	makeCarrierNode,
	newThreadId,
	nodeAtPoint,
	pinInitial,
	removeThread,
	screenToCanvas,
	setThreadResolved,
	threadsOf,
	type CanvasCommentThread,
	type CommentableNodeData,
} from "./comments-data";

/** The unofficial slice of Obsidian's canvas view this module leans on. */
interface CanvasLike {
	tx: number;
	ty: number;
	tZoom: number;
	nodes: Map<string, { getData(): CommentableNodeData; nodeEl?: HTMLElement }>;
	wrapperEl?: HTMLElement;
	canvasEl?: HTMLElement;
	getData(): { nodes: CommentableNodeData[]; edges: unknown[] };
	importData(data: unknown, replace?: boolean): void;
	requestSave(): void;
}

interface CanvasViewLike {
	getViewType(): string;
	canvas?: CanvasLike;
	containerEl: HTMLElement;
	file?: { path: string };
}

export interface PinHost {
	getIdentity(): { name: string; id?: string; color?: string };
	registerInterval(id: number): number;
	getCanvasLeaves(): WorkspaceLeaf[];
}

/**
 * Figma-style comment pins for canvases: one pin per thread, mounted
 * INSIDE its node's own element at the thread's dx/dy so the node's
 * transform carries the pin through drags, pans, and zooms on the
 * compositor — a sibling layer re-synced from data lags every gesture
 * and reads as "not attached". Pins counter-scale by 1/zoom to keep
 * constant screen size like Figma's. Click opens a floating thread card
 * with a composer; placement mode over empty canvas adds freestanding
 * pins on invisible carrier nodes (which are nodes too, so the same
 * mounting applies).
 */
export class CanvasCommentPins {
	private card: HTMLElement | null = null;
	private cardKey: string | null = null;
	private placement: (() => void) | null = null;
	private menuPatches: Array<{
		el: HTMLElement;
		listener: (event: MouseEvent) => void;
	}> = [];
	private transformWatchers: Array<{
		el: HTMLElement;
		observer: MutationObserver;
	}> = [];
	/** Last right-click on a canvas — the node menu event carries no mouse
	    event, so "Add comment" on a node uses this to pin at the click. */
	private lastRightClick: { x: number; y: number; time: number } | null = null;

	constructor(private host: PinHost) {}

	start(): void {
		this.host.registerInterval(
			window.setInterval(() => this.renderAll(), 400),
		);
	}

	stop(): void {
		this.closeCard();
		this.cancelPlacement();
		for (const { el, listener } of this.menuPatches) {
			el.removeEventListener("contextmenu", listener, { capture: true });
		}
		this.menuPatches = [];
		for (const { observer } of this.transformWatchers) {
			observer.disconnect();
		}
		this.transformWatchers = [];
		for (const leaf of this.host.getCanvasLeaves()) {
			const view = leaf.view as unknown as CanvasViewLike;
			view.containerEl
				.querySelectorAll("[data-critic-pin], .critic-canvas-card")
				.forEach((el) => el.remove());
		}
	}

	// ── Rendering ────────────────────────────────────────────────────

	renderAll(): void {
		for (const leaf of this.host.getCanvasLeaves()) {
			const view = leaf.view as unknown as CanvasViewLike;
			if (view.canvas) {
				this.patchBackgroundMenu(view, view.canvas);
				this.renderCanvas(view);
			}
		}
	}

	/**
	 * Obsidian offers no event for the canvas background context menu, and
	 * its internal handler is bound at construction, so wrapping it never
	 * takes effect. Instead: a capture-phase contextmenu listener arms a
	 * one-shot intercept of Menu.showAtPosition that appends "Add comment"
	 * to whichever menu the same right-click opens. Node clicks are
	 * excluded (the canvas:node-menu event covers those) and the intercept
	 * disarms itself after one show or one tick, whichever comes first.
	 */
	private patchBackgroundMenu(view: CanvasViewLike, canvas: CanvasLike): void {
		const el = canvas.wrapperEl;
		if (!el || this.menuPatches.some((patch) => patch.el === el)) return;
		const pins = this;
		const listener = (event: MouseEvent) => {
			this.lastRightClick = {
				x: event.clientX,
				y: event.clientY,
				time: Date.now(),
			};
			const target = event.target as HTMLElement | null;
			if (target?.closest(".canvas-node, .critic-canvas-pin")) return;
			const proto = Menu.prototype as unknown as {
				showAtPosition: (...args: unknown[]) => unknown;
			};
			const originalShow = proto.showAtPosition;
			let restored = false;
			const restore = () => {
				if (restored) return;
				restored = true;
				proto.showAtPosition = originalShow;
			};
			proto.showAtPosition = function (...args: unknown[]) {
				restore();
				const menu = this as unknown as Menu;
				menu.addSeparator();
				menu.addItem((item) => {
					item
						.setTitle("Add comment")
						.setIcon("message-square-plus")
						.onClick(() => {
							pins.placeThreadAtScreenPoint(
								view,
								canvas,
								event.clientX,
								event.clientY,
							);
						});
				});
				return originalShow.apply(this, args);
			};
			window.setTimeout(restore, 0);
		};
		el.addEventListener("contextmenu", listener, { capture: true });
		this.menuPatches.push({ el, listener });
	}

	/**
	 * The rendered scale, derived from a reference node's screen rect vs
	 * its data — Obsidian's tZoom is not the linear scale factor, and this
	 * needs no assumptions about the internal zoom representation.
	 */
	private canvasScale(canvas: CanvasLike): number {
		for (const node of canvas.nodes.values()) {
			const data = node.getData();
			if (!node.nodeEl || !data.width) continue;
			const rect = node.nodeEl.getBoundingClientRect();
			// offsetWidth, not data.width: the rect includes the node's
			// borders, and dividing by the data width biases the scale.
			const layout = node.nodeEl.offsetWidth;
			if (rect.width > 0 && layout > 0) return rect.width / layout;
		}
		return 1;
	}

	/** Map a screen point to canvas coordinates via a reference node. */
	private screenPointToCanvas(
		canvas: CanvasLike,
		clientX: number,
		clientY: number,
	): { x: number; y: number } | null {
		for (const node of canvas.nodes.values()) {
			const data = node.getData();
			if (!node.nodeEl || !data.width) continue;
			const rect = node.nodeEl.getBoundingClientRect();
			const layout = node.nodeEl.offsetWidth;
			if (rect.width === 0 || layout === 0) continue;
			const scale = rect.width / layout;
			return {
				x: data.x + (clientX - rect.x) / scale,
				y: data.y + (clientY - rect.y) / scale,
			};
		}
		return null;
	}

	private renderCanvas(view: CanvasViewLike): void {
		const canvas = view.canvas;
		if (!canvas) return;
		this.watchTransform(view, canvas);

		const zoom = this.canvasScale(canvas);
		const identity = this.host.getIdentity();
		const seen = new Set<string>();
		for (const node of canvas.nodes.values()) {
			const nodeEl = node.nodeEl;
			// Unmounted (virtualized) nodes get their pins when their element
			// comes back; a pin can't outlive the element it rode on.
			if (!nodeEl || !nodeEl.isConnected) continue;
			const data = node.getData();
			for (const thread of threadsOf(data)) {
				const key = `${data.id}:${thread.id}`;
				seen.add(key);
				let pin = nodeEl.querySelector<HTMLElement>(
					`:scope > [data-critic-pin="${CSS.escape(key)}"]`,
				);
				if (!pin) {
					pin = this.createPin(nodeEl, key, view, data.id, thread.id);
				}
				// Node-local coordinates: the node's own transform places the
				// pin on screen, so drags carry it with zero lag.
				pin.style.left = `${thread.dx}px`;
				pin.style.top = `${thread.dy}px`;
				// Constant screen size, Figma-style: undo the canvas zoom.
				pin.style.transform = `translate(0, -100%) scale(${1 / zoom})`;
				pin.classList.toggle("is-resolved", thread.resolved === true);
				// Avatar convention: a known author's identity color fills
				// the pin; unknown authors keep the amber comment ink.
				const first = thread.comments[0];
				const own =
					first &&
					((first.authorId && first.authorId === identity.id) ||
						first.author === identity.name);
				pin.classList.toggle("is-identity", Boolean(own && identity.color));
				pin.style.backgroundColor =
					own && identity.color ? identity.color : "";
				const initial = pin.querySelector(".critic-canvas-pin-initial");
				if (initial) initial.textContent = pinInitial(thread);
				const count = thread.comments.length;
				const badge = pin.querySelector<HTMLElement>(
					".critic-canvas-pin-count",
				);
				if (badge) {
					badge.textContent = String(count);
					badge.style.display = count > 1 ? "" : "none";
				}
			}
		}
		view.containerEl
			.querySelectorAll<HTMLElement>("[data-critic-pin]")
			.forEach((el) => {
				if (!seen.has(el.dataset.criticPin ?? "")) el.remove();
			});

		if (this.cardOwner === view) this.syncCard(view, zoom);
	}

	/**
	 * Keep the open card with its thread: re-parent if Obsidian recreated
	 * the node's element, re-anchor for zoom changes, close it if the
	 * thread disappeared under us.
	 */
	private syncCard(view: CanvasViewLike, zoom: number): void {
		if (!this.card || !this.cardKey) return;
		const [nodeId, threadId] = this.cardKey.split(":");
		const node = this.findNodeObject(view, nodeId);
		const data = node?.nodeEl?.isConnected ? node.getData() : null;
		const thread = data
			? threadsOf(data).find((candidate) => candidate.id === threadId)
			: null;
		if (!node?.nodeEl || !thread) {
			this.closeCard();
			return;
		}
		if (this.card.parentElement !== node.nodeEl) {
			node.nodeEl.appendChild(this.card);
		}
		this.positionCard(view, this.card, thread, zoom);
	}

	/**
	 * Counter-scales must track the zoom gesture frame by frame — the data
	 * poll alone lets pins grow with the canvas for up to 400ms and then
	 * snap back. The canvas pans and zooms by mutating one container's
	 * style, so watch that attribute and re-scale synchronously (the
	 * observer runs before the next paint). Pans keep the scale, so the
	 * epsilon check makes them free.
	 */
	private watchTransform(view: CanvasViewLike, canvas: CanvasLike): void {
		const el =
			canvas.nodes.values().next().value?.nodeEl?.parentElement ??
			canvas.canvasEl;
		if (!el) return;
		this.transformWatchers = this.transformWatchers.filter((watcher) => {
			if (watcher.el.isConnected) return true;
			watcher.observer.disconnect();
			return false;
		});
		if (this.transformWatchers.some((watcher) => watcher.el === el)) return;
		let lastZoom = 0;
		const observer = new MutationObserver(() => {
			const zoom = this.canvasScale(canvas);
			if (!zoom || Math.abs(zoom - lastZoom) < 0.0005) return;
			lastZoom = zoom;
			view.containerEl
				.querySelectorAll<HTMLElement>("[data-critic-pin]")
				.forEach((pin) => {
					pin.style.transform = `translate(0, -100%) scale(${1 / zoom})`;
				});
			if (this.cardOwner === view) this.syncCard(view, zoom);
		});
		observer.observe(el, { attributes: true, attributeFilter: ["style"] });
		this.transformWatchers.push({ el, observer });
	}

	private createPin(
		parent: HTMLElement,
		key: string,
		view: CanvasViewLike,
		nodeId: string,
		threadId: string,
	): HTMLElement {
		const pin = parent.createDiv({
			cls: "critic-canvas-pin",
			attr: { "data-critic-pin": key, "aria-label": "Comment thread" },
		});
		pin.createSpan({ cls: "critic-canvas-pin-initial" });
		pin.createSpan({ cls: "critic-canvas-pin-count" });
		pin.addEventListener("mousedown", (event) => event.stopPropagation());
		pin.addEventListener("click", (event) => {
			event.stopPropagation();
			this.openCard(view, nodeId, threadId, pin);
		});
		return pin;
	}

	// ── Data writes ──────────────────────────────────────────────────

	private writeNode(
		view: CanvasViewLike,
		next: CommentableNodeData | null,
		nodeId: string,
	): void {
		const canvas = view.canvas;
		if (!canvas) return;
		const data = canvas.getData();
		const nodes = data.nodes
			.map((node) => (node.id === nodeId ? next : node))
			.filter((node): node is CommentableNodeData => node !== null)
			.filter((node) => !isEmptyCarrier(node));
		canvas.importData({ ...data, nodes }, true);
		canvas.requestSave();
		this.renderAll();
	}

	private findNodeObject(
		view: CanvasViewLike,
		nodeId: string,
	): { getData(): CommentableNodeData; nodeEl?: HTMLElement } | null {
		for (const node of view.canvas?.nodes.values() ?? []) {
			if (node.getData().id === nodeId) return node;
		}
		return null;
	}

	private findNode(
		view: CanvasViewLike,
		nodeId: string,
	): CommentableNodeData | null {
		return (
			view.canvas?.getData().nodes.find((node) => node.id === nodeId) ?? null
		);
	}

	// ── Entry points ─────────────────────────────────────────────────

	/** "Add comment" from the canvas node menu: pin where the user
	    right-clicked (Figma-style); top-right corner as the fallback when
	    no recent click is known (e.g. command palette on a selection). */
	addThreadToNode(view: CanvasViewLike, nodeId: string): void {
		const node = this.findNode(view, nodeId);
		const canvas = view.canvas;
		if (!node || !canvas) return;
		let dx = node.width;
		let dy = 0;
		// The node menu only ever opens from a right-click, so the last
		// recorded one is always the relevant point — no staleness window
		// (humans read menus for longer than any timeout we would pick).
		const click = this.lastRightClick;
		if (click) {
			const point = this.screenPointToCanvas(canvas, click.x, click.y);
			if (point) {
				dx = point.x - node.x;
				dy = point.y - node.y;
			}
		}
		const thread: CanvasCommentThread = {
			id: newThreadId(),
			dx,
			dy,
			comments: [],
		};
		this.writeNode(view, createThread(node, thread), nodeId);
		const pin = this.pinEl(view, `${nodeId}:${thread.id}`);
		this.openCard(view, nodeId, thread.id, pin);
	}

	/** Comment mode: the next canvas click places a freestanding pin. */
	beginPlacement(view: CanvasViewLike): void {
		this.cancelPlacement();
		const canvas = view.canvas;
		const target = canvas?.wrapperEl ?? view.containerEl;
		if (!canvas || !target) return;
		target.addClass("critic-canvas-placing");
		const onClick = (event: MouseEvent) => {
			event.stopPropagation();
			event.preventDefault();
			cleanup();
			this.placeThreadAtScreenPoint(
				view,
				canvas,
				event.clientX,
				event.clientY,
			);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") cleanup();
		};
		const cleanup = () => {
			target.removeClass("critic-canvas-placing");
			target.removeEventListener("click", onClick, true);
			document.removeEventListener("keydown", onKey, true);
			this.placement = null;
		};
		target.addEventListener("click", onClick, true);
		document.addEventListener("keydown", onKey, true);
		this.placement = cleanup;
	}

	cancelPlacement(): void {
		this.placement?.();
	}

	/** Freestanding pin at a screen point: shared by placement mode and
	    the canvas background context menu. */
	private placeThreadAtScreenPoint(
		view: CanvasViewLike,
		canvas: CanvasLike,
		clientX: number,
		clientY: number,
	): void {
		// Prefer the reference-node mapping (exact at any zoom); an empty
		// canvas falls back to the raw transform fields.
		const host = canvas.wrapperEl ?? view.containerEl;
		const rect = host.getBoundingClientRect();
		const point =
			this.screenPointToCanvas(canvas, clientX, clientY) ??
			screenToCanvas(
				clientX - rect.left,
				clientY - rect.top,
				canvas.tx,
				canvas.ty,
				canvas.tZoom || 1,
			);
		// A point over a node attaches the thread to that node, so the pin
		// rides its moves; only empty canvas gets a freestanding carrier.
		const data = canvas.getData();
		const hit = nodeAtPoint(data.nodes, point);
		if (hit) {
			const thread: CanvasCommentThread = {
				id: newThreadId(),
				dx: point.x - hit.x,
				dy: point.y - hit.y,
				comments: [],
			};
			this.writeNode(view, createThread(hit, thread), hit.id);
			this.openCard(
				view,
				hit.id,
				thread.id,
				this.pinEl(view, `${hit.id}:${thread.id}`),
			);
			return;
		}
		const carrier = makeCarrierNode(newThreadId(), point.x, point.y);
		const thread: CanvasCommentThread = {
			id: newThreadId(),
			dx: 0,
			dy: 0,
			comments: [],
		};
		canvas.importData(
			{ ...data, nodes: [...data.nodes, createThread(carrier, thread)] },
			true,
		);
		canvas.requestSave();
		this.renderAll();
		this.openCard(
			view,
			carrier.id,
			thread.id,
			this.pinEl(view, `${carrier.id}:${thread.id}`),
		);
	}

	private pinEl(view: CanvasViewLike, key: string): HTMLElement | null {
		return view.containerEl.querySelector<HTMLElement>(
			`[data-critic-pin="${CSS.escape(key)}"]`,
		);
	}

	// ── Thread card (Figma's floating thread panel) ──────────────────

	private openCard(
		view: CanvasViewLike,
		nodeId: string,
		threadId: string,
		pin: HTMLElement | null,
		retries = 10,
	): void {
		const key = `${nodeId}:${threadId}`;
		this.closeCard();
		const nodeObject = this.findNodeObject(view, nodeId);
		const data = nodeObject?.getData();
		const thread = data
			? threadsOf(data).find((candidate) => candidate.id === threadId)
			: null;
		if (!nodeObject || !thread) return;

		// The card lives INSIDE the node's element, like the pin, so drags,
		// pans, and zooms carry it on the compositor with zero skew — a
		// viewport-fixed card re-synced from rAF reads lags a frame behind
		// and stutters through zooms. It counter-scales 1/zoom for constant
		// screen size, like the pins. A just-imported carrier's element may
		// not exist until the canvas renders a frame; retry briefly.
		const mount = nodeObject.nodeEl;
		if (!mount || !mount.isConnected) {
			if (retries > 0) {
				requestAnimationFrame(() =>
					this.openCard(
						view,
						nodeId,
						threadId,
						pin ?? this.pinEl(view, key),
						retries - 1,
					),
				);
			}
			return;
		}
		// The card speaks the sidebar's component language: same card
		// shell and type spine, same avatar headers, same composer with
		// primary/cancel actions and the keyboard hint on the right.
		const card = mount.createDiv({
			cls: "critic-card critic-canvas-card",
			attr: { "data-critic-type": "comment" },
		});
		this.card = card;
		this.cardKey = key;
		this.cardOwner = view;

		const header = card.createDiv({ cls: "critic-canvas-card-header" });
		header.createSpan({
			cls: "critic-thread-preview-label",
			text: "Comment",
		});
		if (thread.resolved) {
			header.createSpan({
				cls: "critic-thread-preview-badge",
				text: "Resolved",
			});
		}
		const headerActions = header.createDiv({
			cls: "critic-canvas-card-actions",
		});
		const resolveButton = headerActions.createEl("button", {
			cls: "critic-icon-button critic-check-button",
			attr: {
				type: "button",
				"aria-label": thread.resolved ? "Reopen" : "Resolve",
			},
		});
		setTooltip(resolveButton, thread.resolved ? "Reopen" : "Resolve");
		setIcon(resolveButton, thread.resolved ? "rotate-ccw" : "check");
		resolveButton.addEventListener("click", () => {
			const current = this.findNode(view, nodeId);
			if (!current) return;
			this.writeNode(
				view,
				setThreadResolved(current, threadId, !thread.resolved),
				nodeId,
			);
			this.openCard(view, nodeId, threadId, pin);
		});
		const moreButton = headerActions.createEl("button", {
			cls: "critic-icon-button",
			attr: { type: "button", "aria-label": "More actions" },
		});
		setTooltip(moreButton, "More actions");
		setIcon(moreButton, "more-horizontal");
		moreButton.addEventListener("click", (event) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Delete thread")
					.setIcon("trash-2")
					.onClick(() => {
						const current = this.findNode(view, nodeId);
						if (!current) return;
						this.writeNode(view, removeThread(current, threadId), nodeId);
						this.closeCard();
					}),
			);
			menu.showAtMouseEvent(event);
		});

		const identity = this.host.getIdentity();
		const list = card.createDiv({ cls: "critic-canvas-card-comments" });
		for (const comment of thread.comments) {
			const item = list.createDiv({ cls: "critic-canvas-card-comment" });
			const commentHeader = item.createDiv({ cls: "critic-comment-header" });
			const commentIdentity = commentHeader.createDiv({
				cls: "critic-comment-identity",
			});
			const avatar = commentIdentity.createDiv({
				cls: "critic-avatar",
				text: authorInitials(comment.author),
			});
			const own =
				(comment.authorId && comment.authorId === identity.id) ||
				comment.author === identity.name;
			if (own && identity.color) {
				avatar.style.backgroundColor = identity.color;
			}
			const byline = commentIdentity.createDiv({
				cls: "critic-comment-byline",
			});
			byline.createDiv({
				cls: "critic-comment-author",
				text: comment.author,
			});
			byline.createDiv({
				cls: "critic-comment-date",
				text: formatCommentDate(comment.date),
			});
			item.createDiv({ cls: "critic-canvas-card-text", text: comment.text });
		}

		const composer = card.createDiv({
			cls: "critic-thread-composer critic-composer-shell",
		});
		const textarea = composer.createEl("textarea", {
			cls: "critic-thread-textarea",
			attr: {
				placeholder: thread.comments.length ? "Reply…" : "Comment…",
			},
		});
		const actions = composer.createDiv({ cls: "critic-composer-actions" });
		const submit = actions.createEl("button", {
			cls: "critic-text-button critic-button-primary",
			text: thread.comments.length ? "Reply" : "Comment",
			attr: { type: "button" },
		});
		const cancel = actions.createEl("button", {
			cls: "critic-text-button",
			text: "Cancel",
			attr: { type: "button" },
		});
		cancel.addEventListener("click", () => this.closeCard());
		const help = actions.createSpan({ cls: "critic-composer-help" });
		const helpButton = help.createEl("button", {
			cls: "critic-icon-button critic-composer-help-button",
			attr: { type: "button", "aria-label": "Show composer shortcuts" },
		});
		setIcon(helpButton, "keyboard");
		help.createDiv({
			cls: "critic-composer-help-tooltip",
			text: formatComposerSubmitHint(Platform.isMacOS),
			attr: { role: "tooltip" },
		});

		const syncSubmit = () => {
			submit.disabled = textarea.value.trim().length === 0;
			composer.classList.toggle(
				"has-content",
				textarea.value.trim().length > 0,
			);
		};
		syncSubmit();
		const post = () => {
			const text = textarea.value.trim();
			if (!text) return;
			const current = this.findNode(view, nodeId);
			if (!current) return;
			this.writeNode(
				view,
				addReply(current, threadId, {
					author: identity.name,
					authorId: identity.id,
					date: new Date().toISOString(),
					text,
				}),
				nodeId,
			);
			this.openCard(view, nodeId, threadId, pin);
			this.card
				?.querySelector<HTMLTextAreaElement>(".critic-thread-textarea")
				?.focus();
		};
		submit.addEventListener("click", post);
		textarea.addEventListener("input", syncSubmit);
		textarea.addEventListener("keydown", (event) => {
			event.stopPropagation();
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeCard();
				return;
			}
			if (!isComposerSubmitKey(event)) return;
			event.preventDefault();
			if (!submit.disabled) post();
		});

		this.positionCard(view, card, thread, this.canvasScale(view.canvas!));
		const onDocumentMouseDown = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (target && (card.contains(target) || pin?.contains(target))) return;
			this.closeCard();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") this.closeCard();
		};
		document.addEventListener("mousedown", onDocumentMouseDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		card.dataset.criticCleanup = "true";
		this.cardCleanup = () => {
			document.removeEventListener("mousedown", onDocumentMouseDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
		textarea.focus();
	}

	private cardCleanup: (() => void) | null = null;
	private cardOwner: CanvasViewLike | null = null;

	/**
	 * Place the card next to its pin in NODE-LOCAL coordinates and
	 * counter-scale it. The node's transform does the rest during any
	 * gesture; this re-runs from the render poll and the transform
	 * watcher because the gap offsets are in screen pixels.
	 */
	private positionCard(
		view: CanvasViewLike,
		card: HTMLElement,
		thread: CanvasCommentThread,
		zoom: number,
	): void {
		// Pin geometry: the pin is 32 screen px tall with its tip at dx/dy;
		// open the card top-aligned with the pin's bubble, a constant 38
		// screen px to the right of the tip. Flip against the canvas pane's
		// edge, not the window's: the pane clips its content, so with a
		// sidebar open a window-based check leaves the card cut off.
		const flip = (() => {
			const rect = card.parentElement
				?.querySelector<HTMLElement>(
					`:scope > [data-critic-pin="${CSS.escape(this.cardKey ?? "")}"]`,
				)
				?.getBoundingClientRect();
			const pane = view.canvas?.wrapperEl?.getBoundingClientRect();
			const edge = pane ? pane.right : window.innerWidth;
			return rect ? rect.right + 340 > edge : false;
		})();
		card.style.width = "320px";
		card.style.left = `${thread.dx + (flip ? -352 / zoom : 38 / zoom)}px`;
		card.style.top = `${thread.dy - 32 / zoom}px`;
		card.style.transform = `scale(${1 / zoom})`;
		card.classList.toggle("is-flipped", flip);
		card.style.setProperty("--critic-canvas-caret-y", "16px");
	}

	closeCard(): void {
		this.cardCleanup?.();
		this.cardCleanup = null;
		this.card?.remove();
		this.card = null;
		this.cardKey = null;
		this.cardOwner = null;
	}
}
