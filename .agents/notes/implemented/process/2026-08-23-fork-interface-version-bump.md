# Agent Note: Bump the fork's interface version on every user-visible release

Status: implemented

English | [中文](2026-08-23-fork-interface-version-bump.zh.md)

## Problem

The gradient06 fork renders a custom interface version line in the sidebar footer (`interface v0.1.1-rc.2-g06.1` in `packages/client/ui-sidebar/src/client/SidebarRoot.tsx`). The string is hand-maintained: nothing in the build or the gates advances it with the code. `scripts/sync-upstream.sh` ends with a reminder to bump it, but that script runs only on upstream syncs, so regular feature work ships with no prompt at all. The French interface release (2026-08-23, French default locale plus complete `fr` dictionaries) went out with the footer still at `g06.1` until asked — exactly the gap the reminder was meant to close.

## Decision

Every user-visible change to the fork's web interface bumps the version string in `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` **in the same commit that ships the change**, and regenerates the sidebar snapshot (`pnpm exec vitest run packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx -u`) because the snapshot pins the rendered line — the two must land together or `test:gui` fails.

The format stays `interface v<upstream-version>-g06.<n>`: the upstream version the fork tracks, then the fork release counter. `<n>` increments by one per fork release; the `title` attribute (`Interface custom (fork gradient06)`) does not change. The current line is `interface v0.1.1-rc.2-g06.2` (bumped 2026-08-23 with the French interface).

## Alternatives considered

**Derive the line from `package.json` or `git describe`.** A generated string can never drift from the tree, but the fork deliberately keeps a readable, hand-chosen label (see the sync script's reminder), and a build-time dependency would surface the fork suffix in every artifact digest.

**Rely on the sync-upstream.sh reminder.** It is a post-sync note, not a release gate: feature work never runs that script, and the French release proved the reminder does not fire when it is needed.

## Consequences

The footer stays truthful on the fork's releases. Each bump costs one line plus one snapshot regeneration, and the snapshot test enforces that the pair never drifts. Nothing automates the counter, so the discipline still depends on the author remembering — this note is that memory.
