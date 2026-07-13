import {
	Menu,
	Platform,
	setIcon,
	setTooltip,
	type App,
	type WorkspaceLeaf,
} from "obsidian";
import {
	formatComposerSubmitHint,
	isComposerSubmitKey,
} from "../ui/composer-keys";
import { renderCommentBody } from "../ui/comment-body";
import {
	CARD_EDGE_MARGIN,
	CARD_FLIP_GAP,
	CARD_GAP,
	cardWidthFor,
	nudgeIntoRange,
	PIN_EDGE_MARGIN,
	PIN_SIZE,
	PIN_STACK_GAP,
	pinNearPane,
} from "./geometry";
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
	app: App;
	getIdentity(): { name: string; id?: string; color?: string };
	registerInterval(id: number): number;
	getCanvasLeaves(): WorkspaceLeaf[];
	/** Push a keymap scope that fires onSubmit for the composer submit
	    chord; returns the pop function. Obsidian's global keymap consumes
	    the chord before it can reach the card's textarea. */
	pushComposerScope(onSubmit: () => void): () => void;
}

/** Overlay-local height that's actually usable. Obsidian mobile floats
    a fixed navbar over the pane's bottom edge; anything clamped to the
    raw pane bottom lands underneath it. Desktop has no navbar and gets
    the plain height. */
function usablePaneHeight(overlay: HTMLElement): number {
	const height = overlay.clientHeight;
	const navbar = document.querySelector(".mobile-navbar");
	if (!navbar) return height;
	const overlayRect = overlay.getBoundingClientRect();
	if (!overlayRect.height) return height;
	const navRect = navbar.getBoundingClientRect();
	// A present-but-hidden navbar (display:none — tablets, keyboard up)
	// has an all-zero rect; treating y=0 as its top would collapse the
	// usable height to nothing.
	if (!navRect.height) return height;
	const navTop = navRect.top - PIN_EDGE_MARGIN;
	if (navTop >= overlayRect.bottom) return height;
	const scale = height / overlayRect.height;
	return Math.max(0, (navTop - overlayRect.top) * scale);
}

/**
 * Figma-style comment pins for canvases: one pin per thread, mounted on
 * a screen-space OVERLAY above the canvas (like Obsidian's own node
 * toolbar in .canvas-menu-container) — never inside the zoomed .canvas
 * layer. Node elements are the wrong host twice over: Obsidian destroys
 * and rebuilds them freely (level-of-detail swaps mid-zoom killed pins
 * and cards on film and live), and anything inside the zoom transform
 * has to counter-scale per frame to hold screen size, which reads as
 * comments zooming with the content. The overlay holds native screen
 * size with no transform at all; positions are pure math from the
 * canvas transform matrix and node positions, recomputed pre-paint by a
 * style-attribute observer covering the canvas and its nodes — Obsidian
 * writes those styles every animation frame, so pins and cards track
 * pans, zooms, and drags with zero lag and zero layout reads. Click
 * opens a floating thread card with a composer; placement mode over
 * empty canvas adds freestanding pins on invisible carrier nodes.
 */
export class CanvasCommentPins {
	private card: HTMLElement | null = null;
	private cardKey: string | null = null;
	private placement: (() => void) | null = null;
	private menuPatches: Array<{
		el: HTMLElement;
		listener: (event: MouseEvent) => void;
	}> = [];
	private viewportWatchers: Array<{
		el: HTMLElement;
		observer: MutationObserver;
	}> = [];

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
		for (const { observer } of this.viewportWatchers) {
			observer.disconnect();
		}
		this.viewportWatchers = [];
		for (const leaf of this.host.getCanvasLeaves()) {
			const view = leaf.view as unknown as CanvasViewLike;
			view.containerEl
				.querySelectorAll(
					"[data-critic-pin], .critic-canvas-card, .critic-canvas-overlay",
				)
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
	 * The mapping from canvas coordinates to overlay-local pixels,
	 * derived from the canvas element's rendered rect against the
	 * overlay's — per-frame accurate mid-ease (rects reflect the style
	 * Obsidian writes every animation frame, unlike tZoom, which snaps
	 * to the gesture's target immediately), and immune to the transform
	 * details: transform-origin, and any ancestor transform above the
	 * wrapper, cancel out of the ratios. Two rect reads per call, then
	 * every pin is pure arithmetic.
	 */
	private overlayMapping(
		canvas: CanvasLike,
		overlay: HTMLElement,
	): { originX: number; originY: number; zoom: number } | null {
		const canvasEl = canvas.canvasEl;
		if (!canvasEl) return null;
		const overlayRect = overlay.getBoundingClientRect();
		const canvasRect = canvasEl.getBoundingClientRect();
		const overlayLayout = overlay.offsetWidth;
		const canvasLayout = canvasEl.offsetWidth;
		if (!overlayRect.width || !overlayLayout || !canvasLayout) return null;
		const outerScale = overlayRect.width / overlayLayout;
		return {
			originX: (canvasRect.left - overlayRect.left) / outerScale,
			originY: (canvasRect.top - overlayRect.top) / outerScale,
			zoom: canvasRect.width / canvasLayout / outerScale,
		};
	}

	/**
	 * A node's current position in canvas coordinates. The element's own
	 * translate is authoritative during drags (Obsidian writes it every
	 * frame); data is the fallback for virtualized nodes.
	 */
	private nodeCanvasPoint(node: {
		getData(): CommentableNodeData;
		nodeEl?: HTMLElement;
	}): { x: number; y: number } {
		const transform = node.nodeEl?.style.transform;
		if (transform) {
			try {
				const m = new DOMMatrix(transform);
				return { x: m.e, y: m.f };
			} catch {
				// fall through to data
			}
		}
		const data = node.getData();
		return { x: data.x, y: data.y };
	}

	/** The screen-space layer pins and cards live on, above the zoomed
	    canvas — created on demand, once per canvas wrapper. */
	private overlayFor(canvas: CanvasLike): HTMLElement | null {
		const wrapper = canvas.wrapperEl;
		if (!wrapper) return null;
		const existing = wrapper.querySelector<HTMLElement>(
			":scope > .critic-canvas-overlay",
		);
		if (existing) return existing;
		return wrapper.createDiv({ cls: "critic-canvas-overlay" });
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
		this.watchViewport(view, canvas);
		const overlay = this.overlayFor(canvas);
		if (!overlay) return;

		const identity = this.host.getIdentity();
		const seen = new Set<string>();
		for (const node of canvas.nodes.values()) {
			const data = node.getData();
			const anchorCounts = new Map<string, number>();
			for (const thread of threadsOf(data)) {
				const key = `${data.id}:${thread.id}`;
				seen.add(key);
				let pin = overlay.querySelector<HTMLElement>(
					`:scope > [data-critic-pin="${CSS.escape(key)}"]`,
				);
				if (!pin) {
					pin = this.createPin(overlay, key, view, data.id, thread.id);
				}
				// Threads sharing an anchor (every node thread uses the same
				// top-right corner) stack downward at constant screen spacing,
				// so a node's second pin never hides its first.
				const anchorKey = `${thread.dx},${thread.dy}`;
				const stack = anchorCounts.get(anchorKey) ?? 0;
				anchorCounts.set(anchorKey, stack + 1);
				// Everything positionPins needs to place this pin from the
				// canvas matrix alone, with no DOM or data lookups.
				pin.dataset.criticNode = data.id;
				pin.dataset.criticDx = String(thread.dx);
				pin.dataset.criticDy = String(thread.dy);
				pin.dataset.criticStack = String(stack);
				if (data.relayCommentCarrier === true) {
					pin.dataset.criticCarrier = "1";
				} else {
					delete pin.dataset.criticCarrier;
				}
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

		this.positionPins(view, canvas, overlay);
		if (this.cardOwner === view) this.syncCard(view);
	}

	/**
	 * Place every pin (and the open card) in overlay screen space from
	 * the canvas transform and node positions — pure math, no layout
	 * reads. Runs from the render poll and, pre-paint, from the viewport
	 * observer on every frame Obsidian writes during pans, zooms, and
	 * drags. Pins never scale: they are screen-space UI, not content.
	 */
	private positionPins(
		view: CanvasViewLike,
		canvas: CanvasLike,
		overlay: HTMLElement,
	): void {
		const map = this.overlayMapping(canvas, overlay);
		if (!map) return;
		// Pane bounds are loop-invariant: read once, before any style
		// write, so the per-pin loop stays pure arithmetic (interleaving
		// these reads with the writes would force a reflow per pin, every
		// frame of a pan).
		const maxLeft = overlay.clientWidth - PIN_SIZE - PIN_EDGE_MARGIN;
		const maxTop = usablePaneHeight(overlay) - PIN_SIZE - PIN_EDGE_MARGIN;
		overlay
			.querySelectorAll<HTMLElement>("[data-critic-pin]")
			.forEach((pin) => {
				const node = canvas.nodes.get(pin.dataset.criticNode ?? "");
				if (!node) return;
				const base = this.nodeCanvasPoint(node);
				const x =
					map.originX +
					map.zoom * (base.x + Number(pin.dataset.criticDx ?? "0"));
				const y =
					map.originY +
					map.zoom * (base.y + Number(pin.dataset.criticDy ?? "0"));
				const stack = Number(pin.dataset.criticStack ?? "0");
				const top = pin.dataset.criticCarrier
					? // Carrier pins hang their teardrop tip on the anchor point;
						// node pins hang from their top edge.
						y - PIN_SIZE
					: y + stack * PIN_STACK_GAP;
				// A pin just past an edge gets nudged back inside so it stays
				// tappable — on a phone-width canvas a node's top-right corner
				// routinely sits at the screen edge. Pins further out belong
				// to scrolled-away content and keep leaving the viewport.
				pin.style.left = `${nudgeIntoRange(x, PIN_EDGE_MARGIN, maxLeft)}px`;
				pin.style.top = `${nudgeIntoRange(top, PIN_EDGE_MARGIN, maxTop)}px`;
			});
		if (this.cardOwner === view) this.positionCard(view);
	}

	/**
	 * Keep the open card with its thread: close it if the thread
	 * disappeared under us, otherwise refresh its position. The card
	 * lives on the overlay, so node element recreation (drags, LOD swaps)
	 * never touches it.
	 */
	private syncCard(view: CanvasViewLike): void {
		if (!this.card || !this.cardKey) return;
		const [nodeId, threadId] = this.cardKey.split(":");
		const node = this.findNodeObject(view, nodeId);
		const data = node?.getData() ?? null;
		const thread = data
			? threadsOf(data).find((candidate) => candidate.id === threadId)
			: null;
		if (!thread) {
			this.closeCard();
			return;
		}
		this.positionCard(view);
	}

	/**
	 * Track every frame of a pan, zoom, or drag: Obsidian animates all of
	 * them by writing style attributes (the canvas element for the
	 * viewport, each node element for drags) once per frame, and this
	 * observer runs before the following paint. Repositioning the overlay
	 * from those writes keeps pins and cards glued with zero lag — and
	 * because the overlay never scales, there is nothing to counter-scale
	 * and no mid-ease mismatch: tZoom snaps to the gesture target while
	 * the transform is still easing, which is why anything keyed off the
	 * zoom value (rather than the written transform) visibly pulsed.
	 */
	private watchViewport(view: CanvasViewLike, canvas: CanvasLike): void {
		const el = canvas.canvasEl;
		if (!el) return;
		this.viewportWatchers = this.viewportWatchers.filter((watcher) => {
			if (watcher.el.isConnected) return true;
			watcher.observer.disconnect();
			return false;
		});
		if (this.viewportWatchers.some((watcher) => watcher.el === el)) return;
		const observer = new MutationObserver(() => {
			const overlay = canvas.wrapperEl?.querySelector<HTMLElement>(
				":scope > .critic-canvas-overlay",
			);
			if (overlay) this.positionPins(view, canvas, overlay);
		});
		observer.observe(el, {
			attributes: true,
			attributeFilter: ["style"],
			subtree: true,
		});
		this.viewportWatchers.push({ el, observer });
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
		pin.addEventListener("pointerdown", (event) => event.stopPropagation());
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

	/** Add a thread to a node: every node thread anchors at the standard
	    top-right corner, independent of click position (same-anchor pins
	    stack downward at render time so none hides another). */
	addThreadToNode(view: CanvasViewLike, nodeId: string): void {
		const node = this.findNode(view, nodeId);
		if (!node) return;
		const thread: CanvasCommentThread = {
			id: newThreadId(),
			dx: node.width,
			dy: 0,
			comments: [],
		};
		this.writeNode(view, createThread(node, thread), nodeId);
		const pin = this.pinEl(view, `${nodeId}:${thread.id}`);
		this.openCard(view, nodeId, thread.id, pin);
	}

	/** Comment mode: a node click attaches to that node; an empty-canvas
	    click creates a freestanding carrier. */
	beginPlacement(view: CanvasViewLike): void {
		this.cancelPlacement();
		const canvas = view.canvas;
		const target = canvas?.wrapperEl ?? view.containerEl;
		if (!canvas || !target) return;
		target.addClass("critic-canvas-placing");
		// The crosshair cursor is the only desktop cue and doesn't exist on
		// touch, and Escape is the only exit a keyboard offers — so the
		// mode gets a visible banner with its own cancel.
		const banner = target.createDiv({ cls: "critic-placement-banner" });
		banner.createSpan({
			cls: "critic-placement-banner-text",
			text: Platform.isMobile
				? "Tap to place a comment"
				: "Click to place a comment",
		});
		const bannerCancel = banner.createEl("button", {
			cls: "critic-text-button",
			text: "Cancel",
			attr: { type: "button" },
		});
		bannerCancel.addEventListener("click", () => cleanup());
		// Fence the banner like the card: without this the canvas treats a
		// press on Cancel as the start of a background pan and pointer
		// capture swallows the button's click.
		for (const type of [
			"pointerdown",
			"pointermove",
			"mousedown",
			"mousemove",
			"mouseup",
			"touchstart",
			"dblclick",
			"contextmenu",
		] as const) {
			banner.addEventListener(type, (event) => event.stopPropagation());
		}
		const place = (event: MouseEvent | PointerEvent) => {
			// Pins and open thread cards live inside node elements: a press
			// on one is never a placement. Leave the event alone so the pin
			// or card handles its own click; just exit the mode. The
			// banner's cancel button likewise handles its own click.
			const el = event.target instanceof Element ? event.target : null;
			if (el?.closest(".critic-placement-banner")) return;
			if (el?.closest(".critic-canvas-pin, .critic-canvas-card")) {
				cleanup();
				return;
			}
			event.stopPropagation();
			event.preventDefault();
			cleanup();
			const nodeId = this.findNodeIdFromEventTarget(
				view,
				event.target as Node | null,
			);
			if (nodeId) {
				this.addThreadToNode(view, nodeId);
				return;
			}
			this.placeThreadAtScreenPoint(
				view,
				canvas,
				event.clientX,
				event.clientY,
			);
		};
		const onClick = (event: MouseEvent) => place(event);
		// Touch backstop: the canvas's own touch handling can keep a tap
		// from ever synthesizing a click (it reliably eats mousedown; on
		// some platforms the click too), so placement also recognizes a
		// raw pointer tap — press and release without drift — and dedupes
		// against the click path via cleanup having already run.
		let touchPress: { x: number; y: number; time: number } | null = null;
		const onPointerDown = (event: PointerEvent) => {
			touchPress =
				event.pointerType === "touch"
					? { x: event.clientX, y: event.clientY, time: Date.now() }
					: null;
		};
		const onPointerUp = (event: PointerEvent) => {
			const press = touchPress;
			touchPress = null;
			if (!press || event.pointerType !== "touch") return;
			const drift = Math.hypot(
				event.clientX - press.x,
				event.clientY - press.y,
			);
			if (drift > 12 || Date.now() - press.time > 600) return;
			// Let a synthesized click land first (it carries the real
			// target); if none arrives this tick, the tap places.
			window.setTimeout(() => {
				if (this.placement === cleanup) place(event);
			}, 120);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") cleanup();
		};
		const cleanup = () => {
			banner.remove();
			target.removeClass("critic-canvas-placing");
			target.removeEventListener("click", onClick, true);
			target.removeEventListener("pointerdown", onPointerDown, true);
			target.removeEventListener("pointerup", onPointerUp, true);
			document.removeEventListener("keydown", onKey, true);
			this.placement = null;
		};
		target.addEventListener("click", onClick, true);
		target.addEventListener("pointerdown", onPointerDown, true);
		target.addEventListener("pointerup", onPointerUp, true);
		document.addEventListener("keydown", onKey, true);
		this.placement = cleanup;
	}

	private findNodeIdFromEventTarget(
		view: CanvasViewLike,
		target: Node | null,
	): string | null {
		if (!target) return null;
		for (const node of view.canvas?.nodes.values() ?? []) {
			const data = node.getData();
			if (data.relayCommentCarrier) continue;
			if (node.nodeEl?.contains(target)) return data.id;
		}
		return null;
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
			this.addThreadToNode(view, hit.id);
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
		// Same-thread reopen (posting, resolving): the old card stays on
		// screen until the replacement takes its place in the same tick —
		// closing first blanked the card for a few frames on every submit.
		// A card for a different thread closes immediately as before.
		const previous = this.cardKey === key ? this.card : null;
		const previousCleanup = previous ? this.cardCleanup : null;
		if (!previous) this.closeCard();
		const nodeObject = this.findNodeObject(view, nodeId);
		const data = nodeObject?.getData();
		const thread = data
			? threadsOf(data).find((candidate) => candidate.id === threadId)
			: null;
		if (!nodeObject || !thread) return;

		// The card lives on the same screen-space overlay as the pins: it
		// never scales with the zoom (comments are UI, not content), and
		// node element recreation can't tear it down. Its pin must exist
		// before the side decision can be made; a just-placed thread's pin
		// appears in the same renderAll, so retry is a formality.
		const overlay = view.canvas ? this.overlayFor(view.canvas) : null;
		const mount = overlay;
		if (!mount) {
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
		// Fence pointer events at the card boundary: the card floats over
		// live canvas, and without this the canvas treats card interactions
		// as node interactions — selecting the invisible carrier while the
		// user types, selecting whatever node sits under the composer, and
		// swallowing the submit click as the tail of a node drag (which
		// silently lost the comment). Move events are fenced too: hover
		// leaking through the card arms the canvas's edge-connector
		// affordance on the node beneath, and that interaction intercepts
		// the next pointerdown wherever it lands. The pin fences mousedown
		// the same way.
		for (const type of [
			"pointerdown",
			"pointermove",
			"mousedown",
			"mousemove",
			"mouseup",
			"click",
			"dblclick",
			"contextmenu",
		] as const) {
			card.addEventListener(type, (event) => event.stopPropagation());
		}
		// positionCard finds this card's pin via this marker.
		card.dataset.criticFor = key;
		// Carry the side over from the card being replaced: the flip is
		// sticky per open, and a submit that re-opened on the other side
		// read on film as the card teleporting across its anchor.
		if (previous?.classList.contains("is-flipped")) {
			card.classList.add("is-flipped");
		}

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
			renderCommentBody(
				item.createDiv({ cls: "critic-canvas-card-text" }),
				comment.text,
				{
					app: this.host.app,
					sourcePath: view.file?.path ?? "",
					// In-place navigation would replace the canvas leaf itself,
					// destroying the card and any unsent reply draft.
					openInNewTab: true,
				},
			);
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
		// The shortcut help advertises keys a phone doesn't have; the
		// visible submit and cancel buttons are the whole story there.
		if (!Platform.isMobile) {
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
		}

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
			// The reopened card focuses its own composer when it reveals.
			this.openCard(view, nodeId, threadId, pin);
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

		// The overlay position is pure math from the canvas matrix, so the
		// card can be placed and swapped in immediately — no settle wait,
		// no first-paint clipping. The old same-thread card is removed in
		// the same tick, so a submit never blanks the card.
		previous?.remove();
		previousCleanup?.();
		this.card = card;
		this.cardKey = key;
		this.cardOwner = view;
		if (!card.classList.contains("is-flipped")) {
			this.decideCardSide(view, card, key);
		}
		this.positionCard(view);
		// pointerdown, not mousedown: the canvas prevents default on its
		// touch handling, which cancels the synthesized mouse events, so a
		// mousedown listener never sees background taps on mobile.
		const onDocumentPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (card.contains(target) || pin?.contains(target))) {
				return;
			}
			this.closeCard();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				this.closeCard();
				return;
			}
			// Backup for submit chords Obsidian's keymap ignores (e.g. the
			// meta variant on Linux); the primary path is the pushed scope.
			if (
				document.activeElement === textarea &&
				isComposerSubmitKey(event)
			) {
				event.preventDefault();
				event.stopPropagation();
				if (!submit.disabled) post();
			}
		};
		// The composer advertises mod-Enter, but Obsidian's global keymap
		// consumes that chord before it reaches the textarea (verified:
		// the Control keydown arrived, the Enter never did). A pushed
		// scope gets first chance, same as the sidebar view's composer.
		const popScope = this.host.pushComposerScope(() => {
			if (document.activeElement === textarea && !submit.disabled) {
				post();
			}
		});
		document.addEventListener("pointerdown", onDocumentPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		card.dataset.criticCleanup = "true";
		this.cardCleanup = () => {
			popScope();
			document.removeEventListener(
				"pointerdown",
				onDocumentPointerDown,
				true,
			);
			document.removeEventListener("keydown", onKeyDown, true);
		};
		this.sweepStaleActiveEditor();
		textarea.focus();
	}

	/**
	 * Obsidian's mobile toolbar update reads
	 * `activeEditor?.editor.hasFocus()` with no null check on `.editor`
	 * (verified against app.js). Canvas node selection churn (long-press,
	 * edit-mode enter/exit) can leave workspace.activeEditor pointing at
	 * a node child whose editor is gone, after which every toolbar update
	 * throws until something replaces the entry. The card's focus
	 * transitions are exactly when the toolbar looks, so they sweep the
	 * stale entry first.
	 */
	private sweepStaleActiveEditor(): void {
		const workspace = this.host.app.workspace as unknown as {
			activeEditor: { editor?: unknown } | null;
		};
		if (workspace.activeEditor && !workspace.activeEditor.editor) {
			workspace.activeEditor = null;
		}
	}

	private cardCleanup: (() => void) | null = null;
	private cardOwner: CanvasViewLike | null = null;

	/** The card's pin element on the shared overlay. */
	private cardPin(card: HTMLElement): HTMLElement | null {
		return (
			card.parentElement?.querySelector<HTMLElement>(
				`:scope > [data-critic-pin="${CSS.escape(
					card.dataset.criticFor ?? this.cardKey ?? "",
				)}"]`,
			) ?? null
		);
	}

	/**
	 * Choose which side of its pin the card opens on — decided once per
	 * open and sticky for the card's lifetime (side swaps mid-gesture
	 * read as thrash, and a left-side card can never clip the right
	 * edge). Flip against the canvas pane's edge, not the window's: the
	 * pane clips its content, so with a sidebar open a window-based check
	 * leaves the card cut off.
	 */
	private decideCardSide(
		view: CanvasViewLike,
		card: HTMLElement,
		key: string,
	): void {
		const overlay = card.parentElement;
		const pin = overlay?.querySelector<HTMLElement>(
			`:scope > [data-critic-pin="${CSS.escape(key)}"]`,
		);
		if (!pin || !overlay) return;
		const pinLeft = parseFloat(pin.style.left);
		const edge = overlay.clientWidth || window.innerWidth;
		card.classList.toggle(
			"is-flipped",
			pinLeft + PIN_SIZE + CARD_GAP + cardWidthFor(edge) > edge,
		);
	}

	/**
	 * Place the card against its pin in overlay screen space — constant
	 * gap, constant size, no transform, no layout reads. Runs with
	 * positionPins on every frame Obsidian writes during gestures.
	 */
	private positionCard(view: CanvasViewLike): void {
		const card = this.card;
		if (!card || this.cardOwner !== view || !card.isConnected) return;
		const pin = this.cardPin(card);
		if (!pin) return;
		const pinLeft = parseFloat(pin.style.left);
		const pinTop = parseFloat(pin.style.top);
		const flip = card.classList.contains("is-flipped");
		const overlay = card.parentElement;
		const paneWidth = overlay?.clientWidth || window.innerWidth;
		const paneHeight = overlay
			? usablePaneHeight(overlay)
			: window.innerHeight;
		// A phone-width pane can't fit the designed card beside its pin on
		// either side, so the card shrinks to the pane and clamps to its
		// edges instead of clipping (the pane hides overflow).
		const width = cardWidthFor(paneWidth);
		// A node pin hangs from its anchor, a carrier pin is tip-anchored;
		// the card top-aligns with the pin's bubble either way.
		const rawLeft = pinLeft + (flip ? -(width + CARD_FLIP_GAP) : CARD_GAP);
		const rawTop = pin.dataset.criticCarrier ? pinTop - 4 : pinTop;
		// Width first: the bottom clamp needs the height AT this width (a
		// narrower card wraps taller), so the offsetHeight read comes
		// after the write.
		card.style.width = `${width}px`;
		let left = rawLeft;
		let top = rawTop;
		// Clamp only while the pin is at least near the pane: a pin
		// tracking a scrolled-away anchor takes its card with it — a card
		// glued to the pane edge with no visible anchor reads as detached.
		if (pinNearPane(pinLeft, pinTop, paneWidth, paneHeight)) {
			const cardHeight = card.offsetHeight;
			left = Math.min(
				Math.max(rawLeft, CARD_EDGE_MARGIN),
				Math.max(CARD_EDGE_MARGIN, paneWidth - width - CARD_EDGE_MARGIN),
			);
			top = Math.min(
				Math.max(rawTop, CARD_EDGE_MARGIN),
				Math.max(CARD_EDGE_MARGIN, paneHeight - cardHeight - CARD_EDGE_MARGIN),
			);
			// The caret keeps pointing at the pin through vertical clamp
			// displacement (bounded to the card), but a horizontal clamp
			// slides the card OVER its pin — a side caret would point at
			// nothing, so it hides instead.
			card.style.setProperty(
				"--critic-canvas-caret-y",
				`${Math.min(
					Math.max(16, rawTop - top + 16),
					Math.max(16, cardHeight - 16),
				)}px`,
			);
			card.classList.toggle(
				"is-caret-detached",
				Math.abs(left - rawLeft) > 1,
			);
		} else {
			card.style.setProperty("--critic-canvas-caret-y", "16px");
			card.classList.remove("is-caret-detached");
		}
		card.style.left = `${left}px`;
		card.style.top = `${top}px`;
	}

	closeCard(): void {
		this.cardCleanup?.();
		this.cardCleanup = null;
		this.card?.remove();
		this.card = null;
		this.cardKey = null;
		this.cardOwner = null;
		// Focus returns to the canvas here — another toolbar-update
		// moment; see sweepStaleActiveEditor.
		this.sweepStaleActiveEditor();
	}
}
