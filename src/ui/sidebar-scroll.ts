export function sidebarScrollTopForRender(
	previousSourceKey: string | null,
	currentSourceKey: string,
	currentScrollTop: number,
): number {
	return previousSourceKey === currentSourceKey ? currentScrollTop : 0;
}

/** Whether a render shows a different note than the last one, as opposed to
    the first render or a rebuild of the same note. */
export function sidebarSourceChanged(
	previousSourceKey: string | null,
	currentSourceKey: string,
): boolean {
	return previousSourceKey !== null && previousSourceKey !== currentSourceKey;
}
