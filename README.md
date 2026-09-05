中文 | [English](README.en.md)

# wechat-claude

用微信从手机上操控 Claude Code。发一条 `/run 修复登录的 bug`，你电脑上就会跑起一个
Claude Code session 去执行，结果再发回聊天窗口。基于 ilink Bot API 构建，除 MCP SDK
外没有第三方依赖。

> ⚠️ **它会根据聊天消息在你的电脑上执行代码。** 使用前请先读
> [SECURITY.md](SECURITY.md)。只在你自己掌控的机器上运行，并且只绑定只有你能发消息的账号。

## 前置条件

- **Node.js 20+** 和 **[Claude Code](https://claude.com/claude-code)**。
- **拥有 ClawBot / ilink Bot 权限的微信账号。** 机器人在登录时通过扫码绑定到*你自己的*
  微信账号；它不会被公开检索到，陌生人也无法给它发消息。macOS 是一等公民（launchd
  开机自启 + 原生通知）；Linux/Windows 需要自己托管 daemon。

## 架构

```
微信用户 ←→ ilink Bot API ←→ Daemon（轮询 + 路由）←→ Inbox 文件 ←→ MCP Server（Claude Code）
```

- **Daemon**：独立的 Node.js 进程，轮询微信消息、处理路由命令、把消息写进各 session 的
  inbox 文件。独立于 Claude Code 运行。
- **MCP Server**：注册到 Claude Code 的轻量工具服务。只读自己 session 的 inbox，通过
  ilink API 发回复。不做轮询。

## 安装

```bash
npm install -g wechat-claude-sessions
wechat-claude setup
```

必须**全局安装**，不要用裸 `npx` —— `setup` 会注册一批绝对路径（MCP server、launchd
服务），这些路径得活得比当前 shell 更久，而 npx 的缓存目录并不稳定。从 git 检出构建也
可以，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

`setup` 会注册 MCP server、把 `/wechat` 斜杠命令装到 `~/.claude/commands/`，然后带你
走完扫码登录（它会在浏览器里打开二维码图片，用微信扫）。机器人 token 保存在
`~/.claude/wechat/session.json`（权限 0600）；除非过期，否则不用再扫。

接着启动 daemon 并开启监控：

```bash
wechat-claude daemon install   # macOS：装成 launchd 服务（开机自启 + 崩溃重启）
# 或者不要自启：
wechat-claude daemon           # 前台运行 / 交给你自己的进程管理器
```

最后，在任意 Claude Code session 里输入 `/wechat`。这会启动一个常驻 watcher
（`dist/watch-inbox.js`），它通过 `fs.watch` 即时响应消息，并把该 session 标记为
`👀 监控中`。daemon 在 `/wechat` 时和登录成功后也会自动拉起（它是单例，由 pid 文件守护）。

`wechat-claude daemon install` 会用打包好的模板为*你这台机器*生成 launchd plist，写到
`~/Library/LaunchAgents/com.wechat-claude.daemon.plist`，不需要手工编辑。切换 Node 版本
或全局升级之后重跑一次即可刷新路径。其他 CLI 命令：`wechat-claude login`（重新认证）和
`wechat-claude status`。

如果微信登录过期，daemon 会发一条 macOS 通知并设置一个标志位，`wechat_status` 会把它暴露
出来，于是下一次 `/wechat` 就会提示重新登录 —— 见[故障排查](#故障排查)，因为那时你多半
不在电脑旁。

## 微信命令

在微信里发这些命令来控制路由：

| 命令 | 说明 |
|------|------|
| `/sessions` 或 `/ls` | 列出活跃的 Claude Code session（`👀` = 监控中，正在实时读取消息；`📌 已绑定` = 你的消息都发到这里；`📥 默认接收` = 不带前缀的消息发到这里）。每条两行：`📌 5. fintary:main (fintary-69) 👀` 和 `目录: fintary/data-sync-field-mapping · 3 小时前活跃`。行首是 📌（已绑定）或 📥（默认接收），其余行是 ●/○（2 分钟内是否有动静），所以"消息发到哪"在左边一列就能看到；同名 session 在名字后括号里加 Claude Code 跨会话名；目录是 Claude 当前所在目录（worktree 显示为 `仓库/worktree名`）。空闲的另起 `空闲 (N):` 一段。列表下两行图例：接收标记的含义，以及 `/s` 用法（示例用列表里真实存在的编号）。末尾一段是当前版本标签：`📦 当前版本：wechat-claude @ v1.2.0`，预发布构建显示完整版本号（如 `v1.2.0-dev.session-naming.12.2f0809f`），好区分是哪个测试构建。如果 npm 上有更新的 `latest`，再附一段升级提示（最多每 6 小时查一次 npm，查不到就沿用上次结果，失败后 30 分钟内不再重试） |
| `/s <编号> <消息>` | 按编号发消息给某个 session。编号在 session 生命周期内固定不变 —— 其他 session 开启或关闭都不会让它移位（退役的编号不会被复用；所有 session 都消失后编号重新计数） |
| `/use <编号\|名字\|pid>` | 把你的聊天绑定到某个 session：之后每条不带前缀的消息都直接发给它（daemon 重启后依然有效）。`/use off` 解绑；`/use` 查看当前绑定。被绑定的 session 关闭时会自动解绑 |
| `/s <名字> <消息>` | 按名字发消息（模糊匹配；有歧义时优先选正在监控的 / 最近活跃的） |
| `/s <pid> <消息>` | 按 pid 发消息（同名的会以 `名字#pid` 形式列出） |
| `/run [--safe] [目录] <任务>` | 在 tmux 里起一个新的 Claude session 执行任务。被启动的 session 会被要求把结果发回微信。默认无人值守运行（`--dangerously-skip-permissions`）；加 `--safe` 则用 `--permission-mode acceptEdits`，此时 bash 命令会在电脑端等待确认。第一次无人值守运行时，会替你在 `~/.claude.json` 里接受免确认模式 —— detached 的 session 无法回答 Claude Code 的一次性对话框 —— 并在回复里说明；详见 [SECURITY.md](SECURITY.md) |
| `/runs` | 列出运行中的 `/run` 任务 session |
| `/stop <名字>` | 终止一个 `/run` 任务 session（名字以 `wc-` 开头） |
| `/close <编号\|名字\|pid>` | 远程关闭一个 Claude session —— 终结它的 Claude 进程（以及 MCP server）并从列表移除。该 session 里未保存的工作会丢失。如果一个名字匹配到多个，会列出来而不是瞎猜；`/close <名字> all` 关闭全部匹配项，`/close idle` 清理所有闲置 2 小时以上且未被监控的 session。每次关闭的回复末尾都会附上剩余 session 概览 |
| `/usage` | 查询 Claude 用量是否已达上限（session 集体不回复时用）。会跑一次极小的 headless 探测（默认用 Haiku，见下） |
| `/help` | 显示命令帮助 |
| *（无前缀）* | 发给最近活跃的**监控中** session（没有的话退回到最近活跃的那个） |

**投递反馈**：如果消息落到了一个没在监控 inbox 的 session，daemon 会立刻警告你；如果一条
已投递的消息 2 分钟后仍未被读取，它会再发一条提醒。

### 用量上限（session 集体不回复）

Claude 账号一旦触达用量上限，**所有** session 会同时哑掉：模型调用被拒绝，消息既没人读、
也没人回，从微信看和 daemon 挂了一模一样。为此 daemon 会自己判断：

1. 一条已投递的消息 90 秒没有得到回复，**并且**目标 session 自己的 transcript
   （`~/.claude/projects/…jsonl`，由 MCP server 记下确切路径，不会被同目录下别的 session
   干扰）也 60 秒没有任何写入 —— 即它不是在忙，而是真的停住了 —— daemon 会跑一次 headless
   探测（`claude -p ok`，不加载任何 MCP server）。
2. 探测确认是用量上限，daemon 会主动在微信里说明情况，附上预计恢复时间，并且不再发那条
   容易误导人的"session 可能没在监控"提醒。期间新发的消息照常投递，但会附一条提示。
3. 上限解除后，daemon 会再发一条"已恢复"，并把没被回答的消息重新推起来：还留在 inbox 里的，
   戳一下让 watcher 重新播报（否则那条播报早过去了）；已经被读走、但还没来得及回复的（inbox
   已经被清空，没东西可播报），会先塞回 inbox 再播报。只有确实没得到回复的才会重来，不会重复处理。

探测本身要花一点点额度，所以：同一时间只跑一个；正常状态下最多 5 分钟一次；确认受限之后
探测是免费的（请求被直接拒绝），有明确恢复时间时会等到那个时间点再查。

可选配置（`~/.claude/wechat/config.json`）：

```json
{ "probeModel": "claude-haiku-4-5-20251001", "claudeBin": "~/.local/bin/claude" }
```

- `probeModel` —— 探测用的模型，默认 Haiku（便宜，且订阅的用量上限是账号级的，拒绝同样会
  发生）。设成 `"default"` 用你自己的默认模型 —— 如果你想抓的是 Opus 专属的周上限，就得这么设。
- `claudeBin` —— `claude` 可执行文件路径，launchd 环境下 PATH 很干净时才需要（默认会依次
  找 `~/.local/bin`、`~/.claude/local`、Homebrew、`/usr/local/bin`）。

**图片**会被自动下载解密到 `~/.claude/wechat/media/`（保留 7 天）；路由后的消息文本里带
本地路径（`[图片: /path/to/file.png]`），接收方的 Claude session 可以直接打开该文件。

### /run 的目录解析

`/run <名字> <任务>` 按以下顺序解析 `<名字>`：

1. 名字（或目录 basename）匹配的活跃 session
2. 绝对路径
3. 各搜索目录下的 `<目录>/<名字>` —— 搜索目录来自 `~/.claude/wechat/config.json` 里的
   `repoDirs`（可选，例如 `{"repoDirs": ["~/code"]}`；条目必须是绝对路径或以 `~` 开头，
   无效条目会被报出来），外加每个活跃 session 工作目录的父目录（home 目录本身永远不会
   被当作搜索根）

如果第一个词看起来像目录名但哪里都解析不到，这次运行会被取消并给出解释，而不是悄悄跑到
别的目录里去。当任务文本恰好以一个像路径的词开头时，用 `/run . <任务>` 强制使用默认目录。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `wechat_login` | 生成微信登录二维码 |
| `wechat_login_poll` | 轮询扫码状态 |
| `wechat_get_messages` | 读取并清空 inbox 里的新消息 |
| `wechat_send_text` | 给微信用户发文本回复 |
| `wechat_send_image` | 给微信用户发图片文件（可带说明文字） |
| `wechat_set_session_name` | 为路由设置自定义 session 名 |
| `wechat_status` | 查看连接、daemon 和 session 状态 |
| `wechat_logout` | 断开连接并清除 session |

## Session 命名

Session 会根据工作目录自动命名：

- Git 仓库：`仓库名:分支`（例如 `myapp:main`）
- Worktree：`仓库名/worktree名`（例如 `myapp/feature-x`）
- 非 Git 目录：目录名

要自定义名字，启动监听时直接带上：`/wechat integration`。这会在同一次调用里完成
监听和命名；对一个已经叫这个名字的 session 重复执行是 no-op。也可以随时单独调用
`wechat_set_session_name`。名字必须是不含空格的一个词（`/s <名字> <消息>` 只读一个
词），不能是纯数字（会被当成编号或 pid），并且不能和另一个活着的 session 重名 ——
重名会被拒绝并告知占用者的 pid，而不是悄悄加后缀。

**两套命名空间，别混用。** 上面这些是**微信路由名**，只用于 `/s <名字> <消息>`。
Claude Code 自己给每个 session 另有一个名字（例如 `myapp-a9`），那是其他 Claude
session 用 `SendMessage` 找它时要用的（见 `ListAgents`）。`wechat_status` 的
`Active sessions` 列表会把两个名字并排列出来（`SendMessage: ...` 那一栏），并且
`/s` 也接受 Claude Code 名作为别名，所以看到哪个名字都能路由。

这也让**转发**成为可能：不带前缀的消息会落到默认或绑定的 session，但你说的可能是另一个
（"让 integration 跑一下测试"）。收到消息的 session 会对照 `Active sessions` 列表
（路由名、`SendMessage:` 名或工作目录）推算出目标，用 `SendMessage` 转过去，在微信里
告诉你转给了谁、下次怎么直接 `/s` 过去，并把对方的回复转回来。

## 文件布局

```
~/.claude/wechat/
├── session.json          # ilink 机器人 token（持久化登录）
├── config.json           # 可选配置（例如 /run 用的 repoDirs）
├── bindings.json         # /use 绑定关系（微信用户 -> session）
├── session-numbers.json  # 稳定 session 编号注册表
├── media/                # 下载的图片（保留 7 天）
├── context_tokens.json   # 共享上下文 token（daemon ↔ MCP server）
├── daemon.pid            # daemon 进程 ID
├── daemon.log            # daemon 输出
├── cursor.txt            # 消息轮询游标
├── expired.flag          # 微信登录过期时存在
├── usage-limit.json      # 已知的 Claude 用量上限状态（含已通知的用户）
├── update-check.json     # 上次从 npm 查到的最新版本（/ls 的升级提示用）
├── replies/              # 各 session 最近一次回复各微信用户的时间戳
│   └── <pid>--<userId>
├── nudge/                # 让 watcher 重播积压 inbox 的信号（上限解除后）
│   └── <pid>
├── sessions/             # 已注册的 Claude Code session
│   └── <pid>.json
├── inbox/                # 各 session 的消息队列
│   └── <pid>.json
├── heartbeat/            # watcher 心跳（session 处于 👀 监控中）
│   └── <pid>
└── typing/               # 输入状态
    └── <userId>
```

## CLI

```bash
wechat-claude setup              # 注册 MCP server + /wechat 命令，然后登录
wechat-claude login              # （重新）扫码认证
wechat-claude status             # 查看登录 / daemon / 服务状态
wechat-claude daemon             # 前台运行 daemon
wechat-claude daemon restart     # 重启 daemon（升级后用）
wechat-claude daemon install     # 装成 launchd 服务（macOS）
wechat-claude daemon uninstall   # 移除 launchd 服务
wechat-claude daemon status      # 查看 daemon / 服务状态
wechat-claude daemon log         # 跟踪 daemon 日志
```

在 git 检出里，同样的命令也有对应的 npm script（`npm run daemon:install` 等），它们只是
转调 CLI。

### 升级

```bash
npm install -g wechat-claude-sessions@latest
wechat-claude daemon restart
```

两个长期存活的进程在被替换之前都还揣着旧代码。`daemon restart` 负责 daemon（装了 launchd
就重载该 job，否则停掉再重新拉起）。MCP server 归 Claude Code 管，所以要在那边重连 ——
`/mcp` → `wechat` → Reconnect —— 然后再跑一次 `/wechat` 重新挂上 inbox watcher，因为它绑
的是旧 server 的 pid。

## 工作原理

1. **Daemon** 通过 ilink Bot API 轮询微信（`getupdates` 长轮询）
2. 收到的消息被解析并路由：
   - `/sessions`、`/run`、`/close`、`/use` 这类命令由 daemon 自己处理
   - `/s <目标> <消息>` 路由到指定 session 的 inbox
   - 不带前缀的消息发给你绑定的 session（`/use`），否则发给最近活跃且处于 `👀 监控中`
     的那个
3. 消息被路由时，daemon 会在微信上打开"正在输入"指示
4. **MCP Server** 在 Claude 调用 `wechat_get_messages` 时读取自己的 inbox
5. Claude 处理消息并通过 `wechat_send_text` 回复
6. MCP server 清除输入状态文件，daemon 检测到后停止"正在输入"
7. 如果长时间既没被读也没被回，daemon 会检查是不是撞上了 Claude 用量上限，并在微信里说明
   （见[用量上限](#用量上限session-集体不回复)）

## 回复尾注

session 发到微信的每条回复（`wechat_send_text`，以及 `wechat_send_image` 的说明文字）
末尾都会自动带一行，标明是哪个 session 在说话、怎么直接回它：

```
—— 来自 naming（#4）· 直接回复: /s 4 <消息>
```

编号就是 `/ls` 里的稳定编号，整个 session 生命周期内不变。多个 session 往同一个聊天里
回复时，不用先 `/ls` 再猜是谁说的。不想要的话在 `~/.claude/wechat/config.json` 里加
`"replyFooter": false`。

## 语言

机器人回复默认用中文（面向微信用户）。要切换成英文，在
`~/.claude/wechat/config.json` 里设置 `lang`：

```json
{ "lang": "en" }
```

所有面向用户的字符串都在 `src/i18n.ts`（`zh` + `en`）；环境变量 `WECHAT_LANG` 会覆盖配置
文件里的值。

## 安全

wechat-claude 会响应聊天消息、在你的机器上执行代码。完整威胁模型见
[SECURITY.md](SECURITY.md)。简而言之：

- 只有扫码登录的那个账号能给机器人发消息；它不会被公开检索到，（目前）也不能被拉进群聊。
- `/run` 默认无人值守运行（`--dangerously-skip-permissions`）；用
  `/run --safe <任务>` 可以让 bash 命令需要确认。
- 机器人 token 存在 `~/.claude/wechat/session.json`（0600），整个数据目录是 0700。
  只在你自己掌控的机器上运行。

## 故障排查

- **机器人不回消息了。** 多半是微信登录过期 —— daemon 在过期时会退出，也就再也发不出消息。
  回到 Mac 上运行 `wechat-claude status`；如果显示未登录，用 `wechat-claude login`
  （或在某个 session 里 `/wechat`）重新扫码。需要的话重启 daemon。
- **`/run` 提示"找不到目录"。** 那个名字没解析到项目；把它的父目录加到
  `~/.claude/wechat/config.json` 的 `repoDirs` 里，或者传绝对路径，或者用
  `/run . <任务>` 在默认目录里跑。
- **消息发出去没反应。** 检查 `wechat-claude daemon status` 和
  `wechat-claude daemon log`。如果目标 session 不在 `👀 监控中`，在它里面跑 `/wechat`，
  或者用 `/use <编号>` 绑定。
- **Linux/Windows 上 `daemon install` 什么都没做。** launchd 是 macOS 专有的；请用你自己
  的进程管理器托管 daemon（`wechat-claude daemon`、systemd、pm2……）。

## 卸载

```bash
wechat-claude daemon uninstall  # 移除 launchd 服务（macOS）
claude mcp remove wechat        # 注销 MCP server
rm ~/.claude/commands/wechat.md # 删除斜杠命令
rm -rf ~/.claude/wechat         # 删除 token、inbox、图片、配置
npm uninstall -g wechat-claude-sessions
```

## 环境要求

- Node.js 20+
- Claude Code
- 拥有 ClawBot / ilink Bot 权限的微信账号
- macOS 才有 launchd 自启和原生通知；Linux/Windows 需要自己托管 daemon
