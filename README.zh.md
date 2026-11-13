# dsh-composer-suggestion

DeepSeek Harness 输入框里的「续写推荐」：正在输入时，光标处出现灰色幽灵文字，按 **Tab** 直接补全。

## 行为

| 草稿状态 | 呈现位置 | 操作 |
|---|---|---|
| 非空 | 光标处行内幽灵文字 + `Tab` 角标 | `Tab` 补全，`Esc` 忽略 |
| 为空 | 输入框卡片下方 `↳ …` 推荐条 | 点击，或编辑器聚焦时按 `Tab` |

两个面都由当前 profile 的默认模型生成：Host 半边读取当前会话最近几条消息，向模型要「你这句话的后续」或「你接下来最可能发的那句话」，Client 半边负责渲染。内置语料库负责即时出字，并在 Host 不可达、超时或无结果时兜底。

只有输入框获得焦点后才会出现建议；草稿命中密钥特征时不会外发；`Tab` 仅在幽灵文字真正写入草稿时被拦截，光标在句中时保留原生按键行为。

## 安装

界面路径：**插件 → 添加插件**，按情况粘贴：

| 情况 | 粘贴内容 |
|---|---|
| 已发布到 npm | `dsh-composer-suggestion`（或锁定版本 `dsh-composer-suggestion@1.2.0`） |
| 尚未发布 npm | `git+https://github.com/yaosan1319/dsh-composer-suggestion.git` |

`git+` 前缀与结尾的 `.git` 都不能省。Git 安装会先 `git ls-remote`，需要对 GitHub 的 HTTPS 可达。

## 与 DSH 的接线

- Client：`conversation.input.overlay`（行内幽灵）与 `conversation.composer.dock`（空草稿推荐），通过 `ctx.slots` 注册。
- Client 插入：`inputActions.captureInsertion()` + `inputActions.insertText(text, span)`。
- Host：`POST /dsh-composer-suggestion/suggest`，用 `ctx.webServer.register` 注册，经 `ctx.sessions.get(id).snapshotEvents()` 读转录、`ctx.llm.stream` 流式取模型输出。

## 请求与响应

`json
{ "mode": "continuation", "draft": "把刚才", "language": "zh", "sessionId": "session-…" }
`

返回 `{ "mode": "continuation", "text": "…" }`。路由要求 `x-composer-suggestion: 1` 头、回环 `Host`、以及浏览器同源请求（`Sec-Fetch-Site`/`Origin` 校验），其余一律 405；每会话 30 次/分钟，超限 429。

## 隐私与开销

每次推荐是一次小模型调用，预算 9 秒；空草稿推荐按「会话+语言」缓存 45 秒，「草稿命中疑似密钥」则客户端与 Host 都跳过。不向会话日志写入任何内容。

## 兼容性

需要 `dsh >= 0.2.1-rc.1`。测试：`npm test`（Host 16 项 + Client 18 项）。

## 许可

MIT