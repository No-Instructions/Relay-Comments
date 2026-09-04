function resolveBuildId(manifestVersion, explicitBuildId) {
	return explicitBuildId?.trim() || manifestVersion;
}

module.exports = { resolveBuildId };
