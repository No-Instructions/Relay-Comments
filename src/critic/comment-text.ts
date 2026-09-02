/** Normalize a comment for CriticMarkup storage without changing its Markdown. */
export function sanitizeCommentText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		// "<<}" inside a comment body would close the mark early.
		.replace(/<<(?=\})/g, "<< ")
		.trim();
}
