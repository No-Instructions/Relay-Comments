const UNSAFE_ATTRIBUTE_VALUE = /["\r\n]|>>/;

/**
 * Emits `authorId` alongside `author` so a display name survives independently
 * of the identity provider that minted the ID. Marks whose ID and name are the
 * same value, or that have only one of the two, keep the single `author`
 * attribute. A `date` is written last when one is given, as an ISO-8601
 * timestamp; the sidebar omits it and the CLI supplies it.
 */
export function formatAuthoredComment(
	content: string,
	authorId?: string,
	authorName?: string,
	date?: string,
): string {
	const id = safeAttributeValue(authorId);
	const name = safeAttributeValue(authorName);
	const attributes: string[] = [];
	if (id && name && name !== id) {
		attributes.push(`authorId="${id}"`, `author="${name}"`);
	} else if (id || name) {
		attributes.push(`author="${id ?? name}"`);
	}
	const stamp = safeAttributeValue(date);
	if (stamp) attributes.push(`date="${stamp}"`);
	if (attributes.length === 0) return `{>>${content}<<}`;
	return `{{${attributes.join(" ")}>>${content}<<}}`;
}

function safeAttributeValue(value?: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || UNSAFE_ATTRIBUTE_VALUE.test(trimmed)) return undefined;

	return trimmed;
}
