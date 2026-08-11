import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version?.trim();
if (!targetVersion || !/^\d+\.\d+\.\d+$/.test(targetVersion)) {
	throw new Error(`Expected an x.y.z npm package version, got ${targetVersion}`);
}

const manifest = readJson("manifest.json");
manifest.version = targetVersion;
writeJson("manifest.json", manifest);

const versions = readJson("versions.json");
versions[targetVersion] = manifest.minAppVersion;
writeJson("versions.json", versions);

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}
