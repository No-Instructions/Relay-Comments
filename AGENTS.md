# Relay Comments contributor guidance

Relay Comments is an Obsidian plugin that stores comments and suggestions as
plain CriticMarkup in Markdown notes. Preserve that portability: the file
format is part of the product, and changes to written markup or the Relay
integration surface should be discussed before implementation.

## Development

- Install dependencies with `npm install`.
- Run `npm run check` for TypeScript validation and `npm run lint` for linting.
- Run unit tests with `npm test`; add or update tests under `tests/unit/` with
  behavior changes.
- Run `npm run build` before handing off a production change.
- `main.js` is generated output and must not be committed.

Read `CONTRIBUTING.md` for contribution and release policy and `SPEC.md` for
the product contract. Keep commit subjects in the form `<type>: <subject>`
with a lowercase type such as `feat:`, `fix:`, `ui:`, or `docs:`.
