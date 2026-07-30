export const COMMENT_COMPONENT_SELECTOR =
	'[data-criticmarkup-comment="v1"]';

const COMMENT_BODY_SELECTOR = "[data-criticmarkup-body]";

export type ExternalCommentStatus = "open" | "resolved";

export interface ExternalCommentComponent {
	element: HTMLElement;
	bodyElement: HTMLElement;
	targetElement: HTMLElement;
	author: string | null;
	status: ExternalCommentStatus | null;
	thread: string | null;
	key: string | null;
	label: string | null;
	bodyText: string;
	snapshotKey: string;
}

export interface ExternalCommentGroup {
	snapshotKey: string;
	label: string | null;
	status: ExternalCommentStatus | null;
	comments: ExternalCommentComponent[];
}

export interface ExternalCommentState {
	title: string;
	filePath: string | null;
	comments: ExternalCommentComponent[];
}

function attribute(element: HTMLElement, name: string): string | null {
	const value = element.getAttribute(name)?.trim();
	return value ? value : null;
}

function commentBody(element: HTMLElement): HTMLElement | null {
	for (const candidate of Array.from(
		element.querySelectorAll<HTMLElement>(COMMENT_BODY_SELECTOR),
	)) {
		if (candidate.closest(COMMENT_COMPONENT_SELECTOR) === element) {
			return candidate;
		}
	}
	return null;
}

function elementWithId(root: HTMLElement, id: string): HTMLElement | null {
	if (root.getAttribute("id") === id) return root;
	for (const candidate of Array.from(
		root.querySelectorAll<HTMLElement>("[id]"),
	)) {
		if (candidate.getAttribute("id") === id) return candidate;
	}
	return null;
}

function statusFor(element: HTMLElement): ExternalCommentStatus | null {
	const value = attribute(element, "data-criticmarkup-status");
	return value === "open" || value === "resolved" ? value : null;
}

function normalizedBodyText(element: HTMLElement): string {
	return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function collectExternalCommentComponents(
	root: HTMLElement,
): ExternalCommentComponent[] {
	const components: ExternalCommentComponent[] = [];
	const keyOccurrences = new Map<string, number>();

	for (const element of Array.from(
		root.querySelectorAll<HTMLElement>(COMMENT_COMPONENT_SELECTOR),
	)) {
		const bodyElement = commentBody(element);
		if (!bodyElement) continue;

		const key = attribute(element, "data-criticmarkup-key");
		const keyBase = key ? `key:${key}` : `comment:${components.length}`;
		const occurrence = keyOccurrences.get(keyBase) ?? 0;
		keyOccurrences.set(keyBase, occurrence + 1);
		const targetId = attribute(element, "data-criticmarkup-target");

		components.push({
			element,
			bodyElement,
			targetElement:
				(targetId ? elementWithId(root, targetId) : null) ?? element,
			author: attribute(element, "data-criticmarkup-author"),
			status: statusFor(element),
			thread: attribute(element, "data-criticmarkup-thread"),
			key,
			label: attribute(element, "data-criticmarkup-label"),
			bodyText: normalizedBodyText(bodyElement),
			snapshotKey: occurrence === 0 ? keyBase : `${keyBase}:${occurrence}`,
		});
	}

	return components;
}

export function groupExternalCommentComponents(
	comments: ExternalCommentComponent[],
): ExternalCommentGroup[] {
	const groups: ExternalCommentGroup[] = [];
	const byThread = new Map<string, ExternalCommentGroup>();

	for (const comment of comments) {
		const threadKey = comment.thread ? `thread:${comment.thread}` : null;
		const existing = threadKey ? byThread.get(threadKey) : null;
		if (existing) {
			existing.comments.push(comment);
			if (!existing.label && comment.label) existing.label = comment.label;
			if (existing.status !== "open" && comment.status === "open") {
				existing.status = "open";
			} else if (!existing.status && comment.status) {
				existing.status = comment.status;
			}
			continue;
		}

		const group: ExternalCommentGroup = {
			snapshotKey: threadKey ?? comment.snapshotKey,
			label: comment.label,
			status: comment.status,
			comments: [comment],
		};
		groups.push(group);
		if (threadKey) byThread.set(threadKey, group);
	}

	return groups;
}

export function scrollToExternalComment(
	comment: ExternalCommentComponent,
): boolean {
	const target = comment.targetElement.isConnected
		? comment.targetElement
		: comment.element.isConnected
			? comment.element
			: null;
	if (!target) return false;
	target.scrollIntoView({
		behavior: "smooth",
		block: "center",
		inline: "nearest",
	});
	return true;
}
