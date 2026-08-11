# Contributing to Relay Comments

Relay Comments is MIT licensed and developed in the open. Contributions are
welcome — this plugin is a good place to start if you want to work on the
Relay ecosystem.

The best place to talk to us is the Relay Discord:
[Join our Discord](https://discord.system3.md). For small fixes, just open a
pull request; for larger changes, a quick conversation first saves everyone
time.

## Good first contributions

- Bug fixes with clear reproduction steps
- UI polish and accessibility improvements
- Documentation fixes
- CriticMarkup parsing edge cases (please describe the exact markup input)

## Changes to discuss first

- New commands or settings
- Changes to how markup is written into notes (the file format is the
  product — other tools read it)
- Anything touching the Relay integration surface

## Development

```bash
npm install
npm run check   # typecheck src/
npm run build   # typecheck + produce main.js
```

- `main.js` is a build artifact — don't commit it or include it in pull
  requests.
- Commit subjects follow `<type>: <subject>` with a lowercase type
  (`feat:`, `fix:`, `ui:`, `docs:`, …).
- The unit tests under `tests/unit/` are plain text: run them with
  `npm test` and extend them alongside your change. A test that shows
  your fix or feature working makes a pull request much easier to land —
  and we welcome the contribution either way.

## Releases

Release tags match the version in `package.json` and `manifest.json`, with no
leading `v`. `versions.json` maps each plugin version to its minimum Obsidian
version.

Maintainers prepare a release with `npm version <version> --no-git-tag-version`
and run `npm run release`. Pushing the matching tag builds and verifies
`main.js`, `manifest.json`, and `styles.css`, attests them, and creates the
GitHub release. Release notes must describe the user-facing changes; release
assets are never edited by hand after publication.

## Support and security

Questions, ideas, and design discussion: [Relay Discord](https://discord.system3.md).

Responsible security disclosures: security@system3.md.
