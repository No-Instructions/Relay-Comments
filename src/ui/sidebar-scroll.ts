export function sidebarScrollTopForRender(
	previousSourceKey: string | null,
	currentSourceKey: string,
	currentScrollTop: number,
): number {
	return previousSourceKey === currentSourceKey ? currentScrollTop : 0;
}
