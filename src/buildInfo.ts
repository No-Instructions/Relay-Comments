declare const __RELAY_COMMENTS_VERSION__: string | undefined;
declare const __RELAY_COMMENTS_BUILD_ID__: string | undefined;

// esbuild injects the defines at build time; under other compilers (jest,
// plain tsc) they don't exist, so importing this module must not throw.
export const RELAY_COMMENTS_VERSION =
	typeof __RELAY_COMMENTS_VERSION__ !== "undefined"
		? __RELAY_COMMENTS_VERSION__
		: "0.0.0";
export const RELAY_COMMENTS_BUILD_ID =
	typeof __RELAY_COMMENTS_BUILD_ID__ !== "undefined"
		? __RELAY_COMMENTS_BUILD_ID__
		: "dev";
