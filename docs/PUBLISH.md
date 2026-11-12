# 发布到 GitHub

本仓库已经按公开发布形态准备好（`dsh.bundle.patch`、`files` 白名单、LICENSE、双语 README、CI 与 release 工作流）。
真正剩下的只有三件事：**仓库归属（你的 GitHub 账号）**、**一次认证**、**一次 push**。

## 0. 前置条件

| 项 | 现状（本机） | 需要做 |
|---|---|---|
| Git | 2.56.0 已装 | — |
| 凭据助手 | Git Credential Manager 2.9.1，已把 `credential.helper` 指向绝对路径 | — |
| 网络 | `github.com:443` 可达，`git ls-remote` 成功 | — |
| Git 身份 | 未配置 | 见第 1 步 |
| 仓库归属 | 未知（需要你的账号） | 见第 2 步 |

## 1. 设置提交身份

```powershell
git config --global user.name  "你的名字"
git config --global user.email "你的 GitHub 邮箱"
```

建议用 GitHub 的 `ID+用户名@users.noreply.github.com` 邮箱，避免把真实邮箱写进提交历史。

## 2. 建仓库

两条路，任选：

- **网页（30 秒）**：https://github.com/new → 名称 `dsh-composer-suggestion` → Public → **不要**勾选 README / .gitignore / license（本地已有）→ Create。
- **Token + API**：`$env:GITHUB_TOKEN = 'ghp_...'`（需 `repo` 权限）后由下面的脚本自动创建。

## 3. 一键发布

```powershell
cd plugins/dsh-composer-suggestion
$env:GITHUB_TOKEN = 'ghp_...'      # 可省略；省略时第一次 push 会由 GCM 打开浏览器登录
./publish.ps1 -User <你的用户名> -Name "你的名字" -Email "you@users.noreply.github.com" -Tag
```

脚本做的事：校验身份 → `git init -b main`（若未初始化）→ 提交全部文件 → 添加 `origin` →
（有 token 时）用 REST API 建仓库 → `git push -u origin main` → 推 `v<version>` 标签。

`-Tag` 会触发 `.github/workflows/release.yml`；它在 push tag 时把该版本发布到 npm，
前提是仓库 Secrets 里配了 `NPM_TOKEN`（npm 的 Automation token，对 `dsh-composer-suggestion` 有发布权）。

## 4. 发布到 npm（可选但推荐）

社区市场只按 npm 包名安装，没有 npm 包就只能靠 Git 或自建索引安装。

```powershell
npm login            # 或 npm config set //registry.npmjs.org/:_authToken=...
npm publish --access public
```

包名 `dsh-composer-suggestion` 在 npm 上是先到先得，若被占用，改 `package.json` 的 `name` 与
`plugins/market/index.json` 的条目名后重新打包。

## 5. 进入社区市场（dsh-market / Discover）

- **主市场（插件市场 tab）**：只收录 [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
  目录里的条目。收录方式是去那个仓库开一个 PR，加**一条**记录；站点与该市场次日自动刷新。
  入口信息：仓库 URL、npm 包名、一句英文描述、可选的图标与分类。
- **自建索引源（发现 tab）**：`plugins/market/` 里就是一个可用的 format 1 索引与最小源，
  换成任意 https 静态托管即可让使用者在 **插件 → 发现 → 索引源** 里添加你的地址。

## 6. 版本迭代

1. 改 `package.json` 的 `version`。
2. `npm pack --dry-run` 确认文件列表。
3. 提交后推 `v<version>` 标签（或用 `./publish.ps1 ... -Tag`），由工作流发布。

## 排错

| 现象 | 处理 |
|---|---|
| `Author identity unknown` | 回到第 1 步 |
| push 提示 403 / 无权限 | 清掉旧凭据：`git credential-manager erase`，再 push 重新登录 |
| GCM 没弹窗 | `git credential-manager configure`，确认 `git config --global credential.helper` 指向存在的 exe |
| npm 403 | `NPM_TOKEN` 过期或包名已被他人占用 |
