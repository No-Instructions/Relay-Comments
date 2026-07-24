export function formatAuthoredComment(
	content: string,
	authorId?: string,
): string {
	if (!authorId || /["\r\n]|>>/.test(authorId)) {
		return `{>>${content}<<}`;
	}
	return `{{author="${authorId}">>${content}<<}}`;
}
