# Contributing

[简体中文](CONTRIBUTING.md) | English

Thanks for helping out with TerraView! Bug reports, documentation fixes, examples and code are all welcome. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Issues and pull requests may be written in English or Chinese.

## Questions and feedback

- **Usage questions**: check the [user manual](https://yoy0o.github.io/TerraView/guide/) (Chinese; English pages start at [/en/](https://yoy0o.github.io/TerraView/en/)) and the [FAQ](https://yoy0o.github.io/TerraView/guide/faq) first.
- **Bugs**: use the [bug template](https://github.com/Yoy0o/TerraView/issues/new?template=bug_report.yml). The most useful details are the version, the rendering backend (WebGPU / WebGL), browser and GPU, a minimal reproduction (or the full demo URL including its URL parameters and `#camera` hash), and the output of `JSON.stringify(viewer.snapshot())`.
- **Feature requests**: use the [feature template](https://github.com/Yoy0o/TerraView/issues/new?template=feature_request.yml): the use case first, then the proposal. For larger changes, please open an issue to discuss the direction before writing the code.
- **Security issues**: do not open a public issue; see [SECURITY.md](SECURITY.md).

## Development setup

- Node 20.19+ or 22.12+, installing with npm (the repository ships a `package-lock.json`; `.npmrc` sets `legacy-peer-deps=true`).
- Chrome / Edge 113+ with WebGPU, for the demo app and the browser smoke tests.
- On Windows, scripts are written in Node, not Python. When running vitest from Git Bash, enter the repository with an upper-case drive letter (see the last item of [AGENTS.md](AGENTS.md) §7, Chinese).

```bash
git clone https://github.com/Yoy0o/TerraView.git
cd TerraView
npm install
npm run dev            # demo app at http://localhost:5173
npm run examples:dev   # examples at http://localhost:5175
npm run docs:dev       # documentation site (run together with examples:dev)
```

## Before you write code

**Read [AGENTS.md](AGENTS.md) (Chinese) first.** It is the development guide of this repository (for people and AI agents): coordinate and precision conventions, TSL shader rules, camera invariants, layering rules, and dozens of pitfalls we have already hit. For a specific subsystem, read the matching spec under `docs/agents/`. The conventions broken most often:

- **SDK boundary**: `src/` must not import `demo/` or `examples/`; the demo app and the examples use the SDK only through the package entry `terra-viewer`. `src/` does not read URL parameters or `localStorage`, and does not register global listeners on `window` / `document`.
- **Layering**: dependencies between directories only go upward; `npm run check:layers` enforces it.
- **Shaders**: TSL only. No `onBeforeCompile` and no GLSL string injection (they silently do nothing under WebGPU).
- **Text and errors**: no user-facing strings in `src/`; add them to `src/core/i18n.ts` (for every language). Errors are `TerraViewError` (English message plus a `code`).
- **Dependencies**: versions are pinned. Discuss adding or upgrading a dependency in an issue first, and do not touch `package-lock.json` in passing.

## Submitting changes

1. Fork the repository and branch off `main` (for example `fix/terrain-seams`, `feat/mvt-layer`).
2. Keep changes focused: one pull request does one thing; commit refactors separately from features.
3. Commit messages start with an imperative summary in English that says what changed and why, for example `Volumetric clouds: 1024 weather map above the low tier`. Following the style of the existing history is enough.
4. Push the branch, open a pull request and tick the verification items in the template. Once CI (type check, layering check, unit tests, builds, package check, browser smoke tests) is green, the maintainer reviews and merges it.

## Verify before submitting

```bash
npm run verify    # type check, layering check, unit tests, library build and declarations, demo and examples builds: all must pass
```

Depending on what you changed, also run:

| Changed | Also run |
| --- | --- |
| Math, scheduling rules, data formats | Add unit tests under `tests/` (follow the existing ones) |
| Rendering, workers, the container, levels | `npm run smoke:build && npm run smoke` (Playwright with your local Chrome), and look at it in a real browser (manual checklist in [AGENTS.md](AGENTS.md) §6) |
| `docs/` | `npm run site:build` (fails on dead links and Vue template errors in the Markdown) |
| Package contents, exports, workers, styles | `npm run build && npm run check:package` (size budgets) |

Never make a check pass by editing or deleting tests.

## Keeping the docs in sync

- **Public API** changes (exports, class names, container behavior): update [docs/api.md](docs/api.md) (Chinese) and the "Unreleased" section of [CHANGELOG.md](CHANGELOG.md); when host apps are affected, also update the user manual (`docs/guide/`) and the examples (`examples/`).
- **Bilingual public docs**: the documents below exist in Chinese and English. Change both together (if you cannot update the other language, say so in the pull request and the maintainer will fill it in):

  | Chinese | English |
  | --- | --- |
  | [README.md](README.md) | [README.en.md](README.en.md) |
  | [CONTRIBUTING.md](CONTRIBUTING.md) | [CONTRIBUTING.en.md](CONTRIBUTING.en.md) |
  | [docs/index.md](docs/index.md) (site home) | [docs/en/index.md](docs/en/index.md) |
  | [docs/guide/getting-started.md](docs/guide/getting-started.md) | [docs/en/guide/getting-started.md](docs/en/guide/getting-started.md) |
  | [docs/releases/](docs/releases/) (release notes) | [docs/en/releases/](docs/en/releases/) |
  | [docs/sponsor.md](docs/sponsor.md) | [docs/en/sponsor.md](docs/en/sponsor.md) |

  [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and the templates under `.github/` are bilingual single files. The rest of the user manual, the API reference and `docs/agents/` are Chinese only for now.

## License

Contributions to this repository are licensed under [Apache-2.0](LICENSE) (section 5 of the license). Before bringing in third-party code, check that its license is compatible with Apache-2.0 and keep its copyright notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Never commit credentials (Tianditu, Cesium ion, Google, Mapbox keys and the like), `.env` files or data you are not licensed to share.
