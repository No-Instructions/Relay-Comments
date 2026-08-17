const UNSAFE_ATTRIBUTE_VALUE = /["\r\n]|>>/;

/**
 * Emits `authorId` alongside `author` so a display name survives independently
 * of the identity provider that minted the ID. Marks whose ID and name are the
 * same value, or that have only one of the two, keep the single `author`
 * attribute.
 */
export function formatAuthoredComment(
	content: string,
	authorId?: string,
	authorName?: string,
): string {
	const id = safeAttributeValue(authorId);
	const name = safeAttributeValue(authorName);
	if (!id) {
		return name ? `{{author="${name}">>${content}<<}}` : `{>>${content}<<}`;
	}
	if (!name || name === id) {
		return `{{author="${id}">>${content}<<}}`;
	}

	return `{{authorId="${id}" author="${name}">>${content}<<}}`;
}

function safeAttributeValue(value?: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || UNSAFE_ATTRIBUTE_VALUE.test(trimmed)) return undefined;

	return trimmed;
}
