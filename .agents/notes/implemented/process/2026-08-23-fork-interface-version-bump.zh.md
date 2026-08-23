# Agent Note：每次面向用户的发布都提升 fork 的界面版本号

Status: implemented

[English](2026-08-23-fork-interface-version-bump.md) | 中文

## Problem

gradient06 fork 在侧边栏底部渲染一条自定义的界面版本行（`packages/client/ui-sidebar/src/client/SidebarRoot.tsx` 中的 `interface v0.1.1-rc.2-g06.1`）。该字符串是手工维护的：构建和门禁里没有任何东西让它随代码前进。`scripts/sync-upstream.sh` 的结尾有一条提升它的提醒，但该脚本只在同步上游时运行，因此常规功能开发完全没有提示。法语界面发布（2026-08-23，法语默认 locale 加完整的 `fr` 词典）在有人提醒之前，页脚一直停留在 `g06.1`——这正是这条提醒想要填补的缺口。

## Decision

fork 的 Web 界面每次发生面向用户的变化时，都要在**随该变化一起提交的同一个 commit** 里提升 `packages/client/ui-sidebar/src/client/SidebarRoot.tsx` 中的版本字符串，并重新生成侧边栏快照（`pnpm exec vitest run packages/client/ui-sidebar/tests/sidebar-snapshot.client.spec.tsx -u`），因为快照钉住了渲染出来的那一行——两者必须同时落地，否则 `test:gui` 会失败。

格式保持 `interface v<上游版本>-g06.<n>`：先是 fork 所跟随的上游版本，再是 fork 的发布计数。`<n>` 每次 fork 发布递增一；`title` 属性（`Interface custom (fork gradient06)`）不变。当前这一行是 `interface v0.1.1-rc.2-g06.2`（2026-08-23 随法语界面一起提升）。

## Alternatives considered

**从 `package.json` 或 `git describe` 派生这一行。** 生成的字符串永远不会与代码树脱节，但 fork 刻意保留可读、手工挑选的标签（见同步脚本的提醒），而且构建期依赖会让 fork 后缀出现在每一份产物摘要里。

**只依赖 sync-upstream.sh 的提醒。** 它是同步后的提示，不是发布门禁：功能开发从不运行该脚本，而法语发布已经证明，需要它的时候它并不会触发。

## Consequences

页脚在 fork 的每次发布上都保持真实。每次提升的代价是一行加一次快照重生成，而快照测试强制两者永不脱节。计数器没有任何自动化，因此纪律仍然取决于作者记得——这份 note 就是那份记忆。
