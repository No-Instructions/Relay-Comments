import { COMMENT_COMPONENT_SELECTOR } from "./comment-components";

export const COMMENT_OBSERVER_ATTRIBUTES = [
	"id",
	"data-criticmarkup-comment",
	"data-criticmarkup-body",
	"data-criticmarkup-author",
	"data-criticmarkup-status",
	"data-criticmarkup-thread",
	"data-criticmarkup-key",
	"data-criticmarkup-target",
	"data-criticmarkup-label",
];

function elementOf(node: Node): Element | null {
	return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

function containsComment(node: Node): boolean {
	if (node.nodeType !== 1) return false;
	const element = node as Element;
	// The collector also reads same-origin frames (Canvas embeds).
	const selector = `${COMMENT_COMPONENT_SELECTOR}, iframe`;
	return element.matches(selector) || element.querySelector(selector) !== null;
}

function isCommentTarget(root: HTMLElement, ids: (string | null)[]): boolean {
	const candidates = ids.filter((id): id is string => Boolean(id));
	if (!candidates.length) return false;
	return Array.from(
		root.querySelectorAll(`${COMMENT_COMPONENT_SELECTOR}[data-criticmarkup-target]`),
	).some((comment) =>
		candidates.includes(comment.getAttribute("data-criticmarkup-target")?.trim() ?? ""),
	);
}

function containsCommentTarget(root: HTMLElement, node: Node): boolean {
	if (node.nodeType !== 1) return false;
	const element = node as Element;
	return isCommentTarget(root, [
		element.getAttribute("id"),
		...Array.from(element.querySelectorAll("[id]"), (child) => child.getAttribute("id")),
	]);
}

/** Filter unrelated view traffic without requiring a provider allowlist. */
export function externalCommentMutationMatters(
	root: HTMLElement,
	mutation: MutationRecord,
): boolean {
	const element = elementOf(mutation.target);
	if (!element) return false;
	if (mutation.type === "attributes") {
		const name = mutation.attributeName;
		if (!name || !COMMENT_OBSERVER_ATTRIBUTES.includes(name)) return false;
		const value = element.getAttribute(name);
		if (value === mutation.oldValue) return false;
		// Removing/changing the version marker must remove the indexed comment.
		if (name === "data-criticmarkup-comment") {
			return value === "v1" || mutation.oldValue === "v1";
		}
		if (name === "id") {
			return isCommentTarget(root, [value, mutation.oldValue]);
		}
		return element.closest(COMMENT_COMPONENT_SELECTOR) !== null;
	}
	if (element.closest(COMMENT_COMPONENT_SELECTOR)) return true;
	if (mutation.type !== "childList") return false;
	return [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)].some(
		(node) => containsComment(node) || containsCommentTarget(root, node),
	);
}
