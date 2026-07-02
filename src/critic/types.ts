export type CriticMarkType =
	| "addition"
	| "deletion"
	| "substitution"
	| "comment"
	| "highlight";

export type DisplayMode = "review" | "clean";

export interface CriticMark {
	id: string;
	type: CriticMarkType;
	from: number;
	to: number;
	raw: string;
	content: string;
	contentFrom: number;
	contentTo: number;
	metadataRaw?: string;
	metadata?: Record<string, string>;
	oldText?: string;
	newText?: string;
	line: number;
	ranges: {
		opening?: [number, number];
		closing?: [number, number];
		oldText?: [number, number];
		newText?: [number, number];
		separator?: [number, number];
		commentText?: [number, number];
	};
	valid: boolean;
	error?: string;
}

export interface RenderSegment {
	kind: "text" | "addition" | "deletion" | "comment" | "highlight";
	text: string;
	title?: string;
}
