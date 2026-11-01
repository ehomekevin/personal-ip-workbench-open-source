# Third-party notices and distribution scope

Project-owned code and documentation are licensed under the repository's MIT
license. This grant does not relicense third-party dependencies, protocol
schemas, fonts, artwork, or trademarks.

## Dependencies

Dependencies retain their licenses and copyright notices. Preserve applicable
LICENSE, COPYING, and NOTICE text when redistributing dependencies or a build
that contains them. Determine the actual shipped dependency set rather than
assuming every development dependency is included in the release.

An installed macOS arm64 dependency inventory found MIT, Apache-2.0,
BSD-2-Clause, BSD-3-Clause, ISC, and MPL-2.0 metadata. This is an inventory of
installed packages, not a legal opinion or verification of packages for every
supported operating system.

- `lightningcss` and `lightningcss-darwin-arm64` version 1.33.0 declare
  MPL-2.0. If redistributing covered executable files, comply with the
  corresponding covered-source availability and notice requirements; the
  project's MIT license does not override them.
- `@esbuild/darwin-arm64` version 0.28.2 and
  `@rolldown/binding-darwin-arm64` version 1.2.12 declare MIT, but the installed
  platform packages did not include a separate license file in the inventory.
  Resolve and preserve the applicable upstream notices before bundling these
  binaries for distribution.
- Apache-2.0 dependencies retain their license, applicable NOTICE text, and
  modification notices where required.

`node_modules` and generated builds are not source-distribution inputs. A
separate binary or bundled release needs its own dependency and notice review,
including optional platform-specific packages.

## Interface artwork and names

The interface uses system fonts and project-authored neutral SVGs in
`apps/web/public/workbench/`. Platform labels identify integrations; they are
text labels rather than redistributed platform logos. The source interface
no longer depends on the former personal-brand font, avatar, or logo assets.

User-imported or generated media retains its own rights and permissions; it
is not automatically covered by the project's MIT license. Third-party names
and trademarks remain the property of their respective holders. Their use
here does not imply endorsement or grant trademark rights.

## Codex protocol schemas

`tests/service-agent/schemas/v2` contains Codex 0.161.0 protocol schemas bound
to adapter hashes for synthetic protocol tests. It does not contain captured
host sessions. The upstream source is
[openai/codex at rust-v0.161.0](https://github.com/openai/codex/tree/rust-v0.161.0).
These schemas are licensed under Apache-2.0; their directory retains the
upstream LICENSE and NOTICE. The repository's root MIT license does not
replace those terms.
