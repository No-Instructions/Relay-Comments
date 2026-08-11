import { existsSync, readFileSync, statSync } from "node:fs";

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const versions = readJson("versions.json");
let failed = false;

check(manifest.id === "relay-comments", 'manifest id must be "relay-comments"');
check(manifest.name === "Relay Comments", 'manifest name must be "Relay Comments"');
check(
	typeof manifest.description === "string" &&
		manifest.description.length <= 250 &&
		/[.!?]$/.test(manifest.description),
	"manifest description must be at most 250 characters and end with punctuation",
);
check(!/obsidian/i.test(manifest.id), "manifest id must not include Obsidian");
check(!/obsidian/i.test(manifest.name), "manifest name must not include Obsidian");
check(
	/^\d+\.\d+\.\d+$/.test(manifest.version),
	"manifest version must use x.y.z SemVer",
);
check(
	manifest.version === packageJson.version,
	"manifest version must match package version",
);
check(
	packageLock.version === packageJson.version &&
		packageLock.packages?.[""]?.version === packageJson.version,
	"package-lock version must match package version",
);
check(
	versions[manifest.version] === manifest.minAppVersion,
	"versions.json must map manifest version to minAppVersion",
);
check(
	manifest.isDesktopOnly === false,
	"mobile-compatible release manifest must set isDesktopOnly to false",
);

for (const path of ["main.js", "manifest.json", "styles.css"]) {
	check(existsSync(path), `${path} must exist`);
	if (existsSync(path)) {
		check(statSync(path).size > 0, `${path} must not be empty`);
	}
}

if (failed) process.exit(1);

console.log(
	`release artifacts verified for ${manifest.id} ${manifest.version}`,
);

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function check(condition, message) {
	if (condition) return;
	console.error(`release check failed: ${message}`);
	failed = true;
}
