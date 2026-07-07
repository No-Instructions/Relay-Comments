import { describe, expect, it } from "@jest/globals";
import { parseCriticMarkup } from "src/critic/parse";
import {
	findCriticTaskPrefix,
	findCriticTaskPrefixes,
} from "src/editor/task-prefix";

describe("findCriticTaskPrefix", () => {
	it("detects an unchecked task marker wrapped by a line-leading highlight", () => {
		const text = "{==- [ ] Now on 0.8.6==}\n";
		const [mark] = parseCriticMarkup(text);

		expect(findCriticTaskPrefix(text, mark)).toMatchObject({
			lineFrom: 0,
			markerFrom: 3,
			markerTo: 9,
			checkboxFrom: 6,
			checkboxTo: 7,
			bodyFrom: 9,
			checked: false,
			task: " ",
			indent: "",
		});
	});

	it("detects a checked task marker with ordered-list syntax", () => {
		const text = "  {==1. [X] Shipped==}";
		const [mark] = parseCriticMarkup(text);

		expect(findCriticTaskPrefix(text, mark)).toMatchObject({
			lineFrom: 0,
			markerFrom: 5,
			markerTo: 12,
			checkboxFrom: 9,
			checkboxTo: 10,
			bodyFrom: 12,
			checked: true,
			task: "x",
			indent: "  ",
		});
	});

	it("detects nested task markers inside a multiline mark", () => {
		const text = "{==- [x] Parent\n  - [ ] child\n    - [x] grandchild==}";
		const [mark] = parseCriticMarkup(text);
		const lineBody = (from: number) => {
			const newline = text.indexOf("\n", from);
			return text.slice(from, newline === -1 ? mark.contentTo : newline);
		};

		expect(
			findCriticTaskPrefixes(text, mark).map((prefix) => ({
				marker: text.slice(prefix.markerFrom, prefix.markerTo),
				body: lineBody(prefix.bodyFrom),
				checked: prefix.checked,
				task: prefix.task,
				indent: prefix.indent,
			})),
		).toEqual([
			{ marker: "- [x] ", body: "Parent", checked: true, task: "x", indent: "" },
			{ marker: "- [ ] ", body: "child", checked: false, task: " ", indent: "  " },
			{
				marker: "- [x] ",
				body: "grandchild",
				checked: true,
				task: "x",
				indent: "    ",
			},
		]);
	});

	it("ignores task-like text when the mark is not at the line start", () => {
		const text = "Before {==- [ ] not a rendered task==}";
		const [mark] = parseCriticMarkup(text);

		expect(findCriticTaskPrefix(text, mark)).toBeNull();
	});

	it("ignores substitutions because their visible ranges are split", () => {
		const text = "{~~- [ ] old~>new~~}";
		const [mark] = parseCriticMarkup(text);

		expect(findCriticTaskPrefix(text, mark)).toBeNull();
	});
});
