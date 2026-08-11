const CRITIC_MARKER_CHARACTERS = /[{}+=\-~><]/;

export interface TextChange {
	from: number;
	deleted: string;
	inserted: string;
}

/**
 * Decorations and parsed marks can be reused when every change is plain text
 * after the final CriticMarkup range. Existing ranges and their DOM metadata
 * are unchanged in that case, so a full-document parse buys us nothing.
 */
export function canReuseCriticStateForTrailingChanges(
	lastMarkEnd: number,
	changes: TextChange[],
): boolean {
	return (
		changes.length > 0 &&
		changes.every(
			(change) =>
				change.from >= lastMarkEnd &&
				!CRITIC_MARKER_CHARACTERS.test(change.deleted) &&
				!CRITIC_MARKER_CHARACTERS.test(change.inserted),
		)
	);
}
