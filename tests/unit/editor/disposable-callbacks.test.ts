import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { DisposableCallbacks } from "src/editor/disposable-callbacks";

test("callbacks preserve receivers, results and exceptions until disposal", () => {
	const lifetime = new DisposableCallbacks();
	const callback = jest.fn(function (this: { base: number }, n: number) {
		return this.base + n;
	});
	const wrapped = lifetime.wrap(callback);
	expect(wrapped.call({ base: 4 }, 3)).toBe(7);
	const error = new Error("original failure");
	const throwing = lifetime.wrap(() => { throw error; });
	expect(throwing).toThrow(error);
	lifetime.dispose();
	lifetime.dispose();
	expect(wrapped(1)).toBeUndefined();
	expect(throwing()).toBeUndefined();
	expect(callback).toHaveBeenCalledTimes(1);
	expect(() => lifetime.wrap(() => 1)).toThrow("already disposed");
});

test("retained proxies release callbacks and their owners, even after minification", () => {
	const code = transformSync(readFileSync("src/editor/disposable-callbacks.ts", "utf8"), {
		loader: "ts", format: "cjs", minify: true, target: "es2018",
	}).code;
	const script = `
		const m = {exports:{}};
		new Function('module','exports',${JSON.stringify(code)})(m,m.exports);
		const Lifetime = m.exports.DisposableCallbacks;
		const proxies=[], refs=[], controls=[];
		function cycle(dispose) {
			const owner={payload:new Array(100000).fill(42)};
			const callback=()=>owner.payload.length;
			const lifetime=new Lifetime();
			const proxy=lifetime.wrap(callback);
			if(proxy()!==100000) throw Error('Callback did not execute');
			(dispose ? refs : controls).push(new WeakRef(owner),new WeakRef(callback));
			proxies.push(proxy);
			if(dispose) lifetime.dispose();
		}
		(async()=>{
			for(let i=0;i<5;i++) { cycle(true); cycle(false); }
			for(let i=0;i<4;i++) { await new Promise(setImmediate); global.gc(); }
			process.stdout.write(JSON.stringify({released:refs.filter(r=>r.deref()).length,
				control:controls.filter(r=>r.deref()).length, proxies:proxies.length}));
		})().catch(e=>{console.error(e);process.exitCode=1});
	`;
	expect(JSON.parse(execFileSync(process.execPath, ["--expose-gc", "-e", script], {
		encoding: "utf8",
	}))).toEqual({ released: 0, control: 10, proxies: 10 });
});
