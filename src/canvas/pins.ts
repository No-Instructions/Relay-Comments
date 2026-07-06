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
	pinInitial,
	pinPosition,
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

const LAYER_CLASS = "critic-canvas-pin-layer";

/**
 * Figma-style comment pins for canvases: one pin per thread, rendered in
 * an overlay layer INSIDE the canvas's transformed container so pins ride
 * pan/zoom natively, then counter-scaled by 1/zoom so they keep constant
 * screen size like Figma's. Click opens a floating thread card with a
 * composer; placement mode adds freestanding pins on invisible carrier
 * nodes.
 */
export class CanvasCommentPins {
	private card: HTMLElement | null = null;
	private cardKey: string | null = null;
	private placement: (() => void) | null = null;
	private menuPatches: Array<{
		el: HTMLElement;
		listener: (event: MouseEvent) => void;
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
		for (const leaf of this.host.getCanvasLeaves()) {
			const view = leaf.view as unknown as CanvasViewLike;
			view.containerEl
				.querySelectorAll(`.${LAYER_CLASS}`)
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
			if (rect.width > 0) return rect.width / data.width;
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
			if (rect.width === 0) continue;
			const scale = rect.width / data.width;
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
		const layer = this.ensureLayer(canvas);
		if (!layer) return;

		const zoom = this.canvasScale(canvas);
		const identity = this.host.getIdentity();
		const seen = new Set<string>();
		for (const node of canvas.nodes.values()) {
			const data = node.getData();
			for (const thread of threadsOf(data)) {
				const key = `${data.id}:${thread.id}`;
				seen.add(key);
				const pos = pinPosition(data, thread);
				let pin = layer.querySelector<HTMLElement>(
					`[data-critic-pin="${CSS.escape(key)}"]`,
				);
				if (!pin) {
					pin = this.createPin(layer, key, view, data.id, thread.id);
				}
				pin.style.left = `${pos.x}px`;
				pin.style.top = `${pos.y}px`;
				// Constant screen size, Figma-style: undo the canvas zoom.
				pin.style.transform = `translate(-4px, -100%) scale(${1 / zoom})`;
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
		layer.querySelectorAll<HTMLElement>("[data-critic-pin]").forEach((el) => {
			if (!seen.has(el.dataset.criticPin ?? "")) el.remove();
		});
	}

	private ensureLayer(canvas: CanvasLike): HTMLElement | null {
		// Pins must live beside the nodes, inside the pan/zoom transform.
		const nodeEl = canvas.nodes.values().next().value?.nodeEl;
		const container = nodeEl?.parentElement ?? canvas.canvasEl ?? null;
		if (!container) return null;
		let layer = container.querySelector<HTMLElement>(`.${LAYER_CLASS}`);
		if (!layer) {
			layer = container.createDiv({ cls: LAYER_CLASS });
		}
		return layer;
	}

	private createPin(
		layer: HTMLElement,
		key: string,
		view: CanvasViewLike,
		nodeId: string,
		threadId: string,
	): HTMLElement {
		const pin = layer.createDiv({
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
		const click = this.lastRightClick;
		if (click && Date.now() - click.time < 3000) {
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
		const carrier = makeCarrierNode(newThreadId(), point.x, point.y);
		const thread: CanvasCommentThread = {
			id: newThreadId(),
			dx: 0,
			dy: 0,
			comments: [],
		};
		const data = canvas.getData();
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
	): void {
		const key = `${nodeId}:${threadId}`;
		this.closeCard();
		const node = this.findNode(view, nodeId);
		const thread = node
			? threadsOf(node).find((candidate) => candidate.id === threadId)
			: null;
		if (!node || !thread) return;

		// The card speaks the sidebar's component language: same card
		// shell and type spine, same avatar headers, same composer with
		// primary/cancel actions and the keyboard hint on the right.
		const card = document.body.createDiv({
			cls: "critic-card critic-canvas-card",
			attr: { "data-critic-type": "comment" },
		});
		this.card = card;
		this.cardKey = key;

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

		this.positionCard(card, pin);
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

	private positionCard(card: HTMLElement, pin: HTMLElement | null): void {
		const margin = 12;
		const width = 320;
		card.style.width = `${width}px`;
		const anchor = pin?.getBoundingClientRect();
		let left = anchor ? anchor.right + 10 : window.innerWidth / 2 - width / 2;
		let top = anchor ? anchor.top : window.innerHeight / 3;
		left = Math.min(window.innerWidth - width - margin, Math.max(margin, left));
		const height = card.getBoundingClientRect().height || 200;
		top = Math.min(window.innerHeight - height - margin, Math.max(margin, top));
		card.style.left = `${Math.round(left)}px`;
		card.style.top = `${Math.round(top)}px`;
		// Aim the caret at the pin's vertical center, clear of the corners.
		if (anchor) {
			const caretY = Math.min(
				height - 18,
				Math.max(14, anchor.top + anchor.height / 2 - top),
			);
			card.style.setProperty("--critic-canvas-caret-y", `${Math.round(caretY)}px`);
		} else {
			card.classList.add("critic-canvas-card-no-caret");
		}
	}

	closeCard(): void {
		this.cardCleanup?.();
		this.cardCleanup = null;
		this.card?.remove();
		this.card = null;
		this.cardKey = null;
	}
}
