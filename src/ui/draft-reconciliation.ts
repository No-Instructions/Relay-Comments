export interface DraftTarget {
	id: string;
	signature: string;
	from: number;
}

/**
 * Keep an in-progress draft attached when reparsing changes offset-derived ids.
 * Exact ids win; otherwise use the nearest item with the same stable content
 * signature so duplicate anchors do not steal one another's drafts.
 */
export function reconcileDraftTarget(
	target: DraftTarget,
	candidates: DraftTarget[],
): DraftTarget | null {
	const exact = candidates.find((candidate) => candidate.id === target.id);
	if (exact) return exact;

	let nearest: DraftTarget | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		if (candidate.signature !== target.signature) continue;
		const distance = Math.abs(candidate.from - target.from);
		if (distance < nearestDistance) {
			nearest = candidate;
			nearestDistance = distance;
		}
	}
	return nearest;
}
