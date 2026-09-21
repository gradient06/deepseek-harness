# Agent Note：一棵代码树，两种部署 —— 本地免登录，Docker 经 Caddy 需登录

Status: implemented

[English](2026-08-23-local-and-docker-deployments.md) | 中文

## Problem

这个 fork 从同一份检出服务两类受众：工作站运行（`dsh web`，绑定回环，开发时使用）与经 Caddy 发布到宿主网络的容器。随 `@deepseek-ai/dsh-auth` 加入的登录面由 web bundle 自身组装，这让**每一个**部署都变成必须持有会话：本地运行同样索要密码，而在 `$DSH_HOME/auth/users.json` 中没有任何账号时，守卫对一切请求都回 401——包括 GUI 本身——既没有注册路由，也没有任何命令行途径创建第一个用户。

## Decision

随附的 web profile **不组装 auth 行**：`packages/bundle/web-app/cordis.patch.yml` 让本地部署保持未认证，于是工作站上的 `dsh web` 直接开在对话界面上，信任围栏即是全部门槛。auth 行改为部署叠加层——`deploy/auth.patch.yml`，用 `dsh web --patch <file>` 应用——且 Docker 镜像是它唯一的组装者（Dockerfile CMD），因为 Caddy 把这个容器发布到了回环之外。

在命令行上，`--patch` 必须位于 web 应用自身参数**之前**：一旦出现未知选项，`web` 别名就会把后续参数透传给应用解析器，而应用并不认识 `--patch`。因此镜像运行的是 `dsh web --patch /app/deploy/auth.patch.yml --host 127.0.0.1 --port 8081 --no-open`，其健康检查探测 `/login`（无会话时 200），而不是 `/`（302 跳转到登录页）。

`deploy/auth-add-user.mjs` 在不新增 CLI 表面的前提下引导账号：它按服务校验所用的同一 `scrypt(password, salt, 64)` `<saltHex>:<keyHex>` 形式写入 `$DSH_HOME/auth/users.json`，密码或从终端提示读取，或取 `DSH_AUTH_PASSWORD`。auth 服务在**启动时**加载该存储，因此在服务器已运行期间创建的账号要等到 `docker compose restart dsh` 才可见；文档化的流程先创建账号（`docker compose run --rm … dsh node deploy/auth-add-user.mjs <username>`），再启动。

叠加层保持为一行加上它的配置：`trustedHosts` 与连接行使用同一份授权列表，`cookieSecure: false` 对应纯 HTTP 的本地 compose 文件（TLS 部署将其置为 true）。

## Alternatives considered

**把 auth 行留在 bundle 里，本地运行时再禁用它。** 用受环境变量控制的 `disabled` 让两种模式只差一个文件，代价是让「未认证」成为变量未设置时的默认结果——对于一个可能被公开发布的面来说，这是错误方向的失败。叠加层让每种模式各自声明自己的姿态。

**所有地方都要求认证，包括工作站。** 只有一条代码路径和一套心智模型。代价是本地回路失去零摩擦的特性（在一台用户已经解锁的机器上，每 8 小时登录一次），而这一威胁本就被回环绑定排除在外。

**从 compose 环境变量在容器启动时播种第一个账号。** 这样单靠 `docker compose up` 就能得到可用的登录。代价是把明文密码写进 compose 文件或每次启动的 shell 历史，并把账号创建藏进入口点；一条显式的一次性命令把秘密挡在长期配置之外。

**新增 `dsh auth user add` CLI 命令。** 这是账号管理的惯常归宿。它需要一个新的命令面、配套测试，以及命令内部的一次 loader 启动；helper 脚本以零新增公开表面触及同一个文件，而服务 API（`userAdd`）仍是插件在进程内的路径。

## Consequences

一次提交即可两种方式部署：工作站保留未认证的回环 GUI，容器则端到端必须持有会话——`/` 跳转到法语登录页，`/api/auth/me` 返回用户，且每一条 `/api` 路由（包括 composer 的 `/api/workspace-file` 上传）在没有会话 cookie 时返回 401。两个方向都经过实测：本地 `/` 返回 200 且无跳转、`/api/auth/me` 返回 404；经 Caddy `/` 返回 302 到 `/login`，未认证上传返回 401，带上会话 cookie 则返回 GUI 与用户信息。

容器上的账号管理仍以文件为先：新增或修改账号需要运行 helper 并重启容器；而手工编辑 `users.json` 的部署必须匹配哈希格式，否则登录会以无法区分的「invalid credentials」失败。面向公网的部署还需要 `--trusted-host <authority>`（否则围栏只接受回环授权）以及 `cookieSecure: true`。
