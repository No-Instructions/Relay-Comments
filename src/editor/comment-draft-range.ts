import { structuralPrefixLength, type AnchorRange } from "../critic/anchor-range";

/** Null means the selection cannot safely be wrapped without moving block syntax. */
export function commentDraftContentRange(
	documentText: string,
	from: number,
	to: number,
): AnchorRange | null {
	if (from === to) return { from, to };
	const lineFrom = from === 0 ? 0 : documentText.lastIndexOf("\n", from - 1) + 1;
	const newline = documentText.indexOf("\n", from);
	const lineTo = newline < 0 ? documentText.length : newline;
	const line = documentText.slice(lineFrom, lineTo).replace(/\r$/, "");
	const prefixLength = structuralPrefixLength(line);
	if (newline >= 0 && to > newline + 1) {
		let laterFrom = newline + 1;
		while (laterFrom < to) {
			const laterNewline = documentText.indexOf("\n", laterFrom);
			const laterTo = laterNewline < 0 ? documentText.length : laterNewline;
			if (structuralPrefixLength(documentText.slice(laterFrom, laterTo)) > 0) return null;
			if (laterNewline < 0) break;
			laterFrom = laterNewline + 1;
		}
	}
	if (!prefixLength) return { from, to };
	// Triple-click includes the line break. Keep review markup before it.
	if (to > lineTo + (newline < 0 ? 0 : 1)) return null;
	const contentFrom = Math.max(from, lineFrom + prefixLength);
	let contentTo = Math.min(to, lineFrom + line.length);
	if (/#{1,6}[ \t]+$/.test(line.slice(0, prefixLength))) {
		const closing = /[ \t]+#+[ \t]*$/.exec(line);
		if (closing) contentTo = Math.min(contentTo, lineFrom + closing.index);
	}
	return contentFrom < contentTo ? { from: contentFrom, to: contentTo } : null;
}
