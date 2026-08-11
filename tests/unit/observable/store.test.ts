import { describe, expect, it, jest } from "@jest/globals";
import { ObservableMap, ObservableValue } from "src/observable/store";

describe("ObservableValue", () => {
	it("delivers the current value immediately and follows changes", () => {
		const value = new ObservableValue("first");
		const subscriber = jest.fn();
		const unsubscribe = value.subscribe(subscriber);

		expect(subscriber).toHaveBeenLastCalledWith("first");
		expect(value.set("second")).toBe(true);
		expect(value.set("second")).toBe(false);
		expect(subscriber).toHaveBeenCalledTimes(2);

		unsubscribe();
		value.set("third");
		expect(subscriber).toHaveBeenCalledTimes(2);
	});

	it("provides a change-only listener", () => {
		const value = new ObservableValue(1);
		const listener = jest.fn();
		const unsubscribe = value.on(listener);

		expect(listener).not.toHaveBeenCalled();
		value.set(2);
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe();
		value.set(3);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("ObservableMap", () => {
	it("publishes itself immediately and applies idempotent mutations", () => {
		const map = new ObservableMap<string, { name: string }>(
			(left, right) => left.name === right.name,
		);
		const subscriber = jest.fn();
		map.subscribe(subscriber);

		expect(subscriber).toHaveBeenLastCalledWith(map);
		expect(map.set("user", { name: "Bongo Cat" })).toBe(true);
		expect(map.set("user", { name: "Bongo Cat" })).toBe(false);
		expect(map.get("user")).toEqual({ name: "Bongo Cat" });
		expect(subscriber).toHaveBeenCalledTimes(2);

		expect(map.delete("missing")).toBe(false);
		expect(map.delete("user")).toBe(true);
		expect(subscriber).toHaveBeenCalledTimes(3);
	});

	it("reconciles a snapshot with one notification", () => {
		const map = new ObservableMap<string, string>();
		const listener = jest.fn();
		map.on(listener);

		expect(
			map.reset([
				["one", "One"],
				["two", "Two"],
			]),
		).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(map.entries()).toEqual([
			["one", "One"],
			["two", "Two"],
		]);

		expect(
			map.reset([
				["one", "One"],
				["two", "Two"],
			]),
		).toBe(false);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
