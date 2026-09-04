import fs from "node:fs";
import { CONFIG_FILE } from "./paths.js";

export type Lang = "zh" | "en";

// Resolve the bot reply language: WECHAT_LANG env wins (handy for tests), then
// the `lang` field in ~/.claude/wechat/config.json, else Chinese.
export function getLang(): Lang {
  const env = process.env.WECHAT_LANG;
  if (env === "en" || env === "zh") return env;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (typeof parsed === "object" && parsed !== null) {
      const lang = (parsed as Record<string, unknown>).lang;
      if (lang === "en" || lang === "zh") return lang;
    }
  } catch {}
  return "zh";
}

export function formatAgo(ms: number, lang: Lang = "zh"): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (lang === "en") {
    if (ms < 60_000) return "just now";
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    return `${d}d ago`;
  }
  if (ms < 60_000) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (h < 24) return `${h} 小时前`;
  return `${d} 天前`;
}

// Content markers injected into the message text the receiving Claude sees.
export function marker(
  kind: "image" | "voice" | "file" | "video",
  lang: Lang = "zh",
  arg?: string
): string {
  if (lang === "en") {
    switch (kind) {
      case "image":
        return "[image]";
      case "voice":
        return `[voice→text] ${arg ?? ""}`;
      case "file":
        return `[file: ${arg ?? ""}]`;
      case "video":
        return "[video]";
    }
  }
  switch (kind) {
    case "image":
      return "[图片]";
    case "voice":
      return `[语音转文字] ${arg ?? ""}`;
    case "file":
      return `[文件: ${arg ?? ""}]`;
    case "video":
      return "[视频]";
  }
}

type Msgs = {
  help: string;
  noSessions: string;
  noSessionsDeliver: string;
  sListUsage: string;
  notFound: (sel: string) => string;
  // routing / delivery
  deliveredUnmonitored: (name: string) => string;
  deliveredNoneMonitored: (name: string) => string;
  bindingCleared: string;
  // /use
  useBound: (name: string, pid: number, warn: string) => string;
  useNotMonitoredWarn: string;
  useCurrent: (name: string, pid: number) => string;
  useNone: string;
  useUnbound: string;
  // /run
  runUsage: string;
  runDirNotFound: (
    dirHint: string,
    sessDirs: string,
    searchDirs: string,
    task: string,
    configNote: string
  ) => string;
  runNoSession: string;
  tmuxMissing: string;
  runStarted: (
    cwd: string,
    task: string,
    perm: string,
    sessionName: string
  ) => string;
  runStartFailed: (err: string) => string;
  bypassAutoAccepted: string;
  bypassUnavailable: (configFile: string) => string;
  permSkip: string;
  permSafe: string;
  // /runs, /stop
  runsNone: string;
  runsList: (count: number, body: string) => string;
  runsEntry: (n: number, name: string, mins: number, task: string) => string;
  runsEntryBare: (n: number, name: string) => string;
  stopNumOutOfRange: (n: number) => string;
  stopNotFound: (sel: string) => string;
  stopped: (count: number, body: string) => string;
  stopFailed: string;
  // /close
  closeUsage: string;
  closeNoIdle: string;
  closeAmbiguous: (sel: string, count: number, body: string) => string;
  closeAmbiguousEntry: (name: string, pid: number, ago: string, mon: string) => string;
  monitoringSuffix: string;
  closed: (count: number, body: string, summary: string) => string;
  closeFailedLine: (name: string, pid: number) => string;
  closeOkLine: (name: string, pid: number) => string;
  remainingSummary: (total: number, monitored: number) => string;
  // run-end + delivery warnings
  runEnded: (name: string, mins: number, task: string) => string;
  unreadWarn: (name: string) => string;
  // /sessions listing
  sessionsHeader: (count: number) => string;
  // claude: the Claude Code cross-session name (ListAgents/SendMessage), when
  // known — the one thing that tells two same-named sessions apart.
  sessionEntry: (
    dot: string,
    n: number,
    label: string,
    tags: string,
    dir: string,
    ago: string,
    claude: string | undefined
  ) => string;
  idleSection: (body: string) => string;
  idleEntry: (
    n: number,
    label: string,
    ago: string,
    dir: string,
    claude: string | undefined
  ) => string;
  boundTag: string;
  defaultTag: string;
  monitoringTag: string;
  legendBound: string;
  legendDefault: string;
  legendNumbers: string;
  // example: a number that is actually in the list, so the sample command works
  legendRoute: (example: number) => string;
  // Labelled "this is the running version" footer, full version string.
  versionLine: (version: string) => string;
  updateAvailable: (current: string, latest: string) => string;
  // trailer on every reply a session sends; n is the stable /ls number
  replyFooter: (name: string, n: number | undefined) => string;
  noRepoDirs: string;
  // usage limit
  usageLimited: (resetHint: string, waiting: string) => string;
  usageRecovered: (mins: number, pending: string) => string;
  usageNoteOnSend: (resetHint: string) => string;
  usageChecking: string;
  usageOk: string;
  usageStatusLimited: (resetHint: string, mins: number) => string;
  usageUnknown: (detail: string) => string;
  usageResetUnknown: string;
  usageMacNotice: (resetHint: string) => string;
  usagePendingNudged: (count: number) => string;
  usagePendingNone: string;
  usageWaitingList: (body: string) => string;
  // config warnings
  cfgNotArray: string;
  cfgNonString: string;
  cfgNotAbsolute: (d: string) => string;
  cfgBadJson: string;
  // expiry
  loginExpired: string;
};

const zh: Msgs = {
  help: [
    "🤖 wechat-claude 用法",
    "",
    "👀 看",
    "/ls — session 列表",
    "/ls all — 展开闲置的",
    "",
    "💬 聊",
    "/use 3 — 绑定 3 号，之后消息都发给它",
    "/use off — 取消绑定",
    "/s 3 你好 — 只发这一条给 3 号",
    "",
    "🚀 跑任务",
    "/run 修复登录bug — 新开 Claude 执行（默认无人值守）",
    "/run myapp 跑测试 — 指定目录",
    "/run --safe <任务> — bash 命令需在电脑确认",
    "/runs — 任务列表",
    "/stop 1 — 按编号终止，/stop all 全部",
    "",
    "🧹 清理",
    "/close 3 — 关闭 3 号",
    "/close idle — 清理全部闲置",
    "/close myapp all — 关闭同名全部",
    "",
    "🩺 状态",
    "/usage — 查 Claude 用量是否被限制（session 集体不回复时用）",
    "",
    "📌 备注",
    "· 编号固定不变，可用编号/名字/pid 选 session",
    "· 普通消息发给绑定的 session（没绑定就发给最近活跃且监控中的）",
    "· 📷 可以直接发图片，Claude 能看到内容",
    "· 🎤 语音会自动转成文字",
  ].join("\n"),
  noSessions: "当前没有活跃的 Claude session。",
  noSessionsDeliver: "当前没有活跃的 Claude session，消息无法投递。",
  sListUsage: "用法: /s <编号|名字> <消息>\n例: /s 1 你好\n发送 /sessions 查看可用列表。",
  notFound: (sel) => `找不到 "${sel}"。发送 /sessions 查看列表。`,
  deliveredUnmonitored: (name) =>
    `已投递到 "${name}"，但该 session 未在监控消息（未运行 /wechat），可能不会及时处理。`,
  deliveredNoneMonitored: (name) =>
    `已投递到 "${name}"，但当前没有任何 session 在监控消息（需要在 Claude Code 中运行 /wechat），可能不会及时处理。`,
  bindingCleared: "绑定的 session 已关闭，已自动解除绑定，本条消息按默认路由投递。",
  useBound: (name, pid, warn) =>
    `已绑定 "${name}" (pid ${pid})。之后你的所有消息都会直接发给它。${warn}\n/use off 取消绑定。`,
  useNotMonitoredWarn: "\n注意: 该 session 未在监控消息，回复可能不及时。",
  useCurrent: (name, pid) =>
    `当前绑定: "${name}" (pid ${pid})。\n/use off 取消绑定，/use <编号|名字|pid> 换绑。`,
  useNone: "当前没有绑定。\n/use <编号|名字|pid> — 绑定后你的所有消息都直接发给该 session\n/use off — 取消绑定",
  useUnbound: "已取消绑定，恢复默认路由（最近活跃且监控中的 session）。",
  runUsage:
    "用法: /run [--safe] [目录] <任务>\n\n默认跳过权限确认（无人值守）。加 --safe 则只自动接受编辑，bash 命令需要在电脑上确认。\n\n例:\n/run 检查最近的 PR\n/run myapp 跑一遍测试并修复失败\n/run --safe /path/to/repo 修复 bug",
  runDirNotFound: (dirHint, sessDirs, searchDirs, task, configNote) =>
    `找不到目录 "${dirHint}"，已取消（避免任务跑错地方）。\n\n可用的 session 目录:\n${sessDirs}\n\n也可以用这些目录下的项目名:\n${searchDirs}\n\n或直接给绝对路径。如果 "${dirHint}" 是任务内容而不是目录，用: /run . ${task}${configNote}`,
  runNoSession: "没有活跃的 session，请指定目录。\n用法: /run <目录> <任务>",
  tmuxMissing: "tmux 未安装，无法启动交互式 session。请在终端中手动运行。",
  runStarted: (cwd, task, perm, sessionName) =>
    `已启动 Claude session\n\n目录: ${cwd}\n任务: ${task}\n权限: ${perm}\ntmux: ${sessionName}\n\n完成后结果会发回微信。\n/runs 查看运行中的任务，/stop ${sessionName} 可终止。\n回到电脑后可运行: tmux attach -t ${sessionName}`,
  runStartFailed: (err) => `启动失败: ${err}`,
  bypassAutoAccepted:
    "提示: 已在 ~/.claude.json 中接受 Claude Code 的免确认模式（bypassPermissionsModeAccepted）。否则 /run 启动的 session 会停在一次性确认对话框上，无人应答而永久卡住。仅需一次。",
  bypassUnavailable: (configFile) =>
    `无法启动任务: 读写 ${configFile} 失败，没能确认免确认模式已开启。直接启动会永久卡在确认对话框上，所以取消了。\n\n解决办法: 在电脑上运行一次 claude --dangerously-skip-permissions 并接受，或改用 /run --safe <任务>。`,
  permSkip: "跳过确认（默认）",
  permSafe: "仅自动接受编辑 (--safe)",
  runsNone: "当前没有 /run 启动的任务 session。",
  runsList: (count, body) =>
    `运行中的任务 (${count}):\n\n${body}\n\n/stop <编号|名称> 终止，/stop all 全部终止\n电脑上: tmux attach -t <名称>`,
  runsEntry: (n, name, mins, task) =>
    `${n}. ${name}（${mins} 分钟前启动）\n   任务: ${task}`,
  runsEntryBare: (n, name) => `${n}. ${name}`,
  stopNumOutOfRange: (n) => `编号 ${n} 超出范围。发送 /runs 查看列表。`,
  stopNotFound: (sel) => `没有找到运行中的 "${sel}"。发送 /runs 查看编号或名称。`,
  stopped: (count, body) => `已终止 ${count} 个任务:\n${body}`,
  stopFailed: "终止失败，可能已退出。发送 /runs 查看。",
  closeUsage:
    "用法:\n/close <编号|名字|pid> — 关闭指定 session\n/close <名字> all — 关闭全部同名 session\n/close idle — 清理全部闲置 session（未监控且 2 小时以上未活跃）\n\n注意: 关闭会终止进程，session 中未保存的工作会丢失。/run 启动的任务请用 /stop。",
  closeNoIdle: "没有闲置的 session（未监控且 2 小时以上未活跃）。",
  closeAmbiguous: (sel, count, body) =>
    `"${sel}" 匹配到 ${count} 个 session:\n\n${body}\n\n全部关闭: /close ${sel} all\n单独关闭: /close <pid>`,
  closeAmbiguousEntry: (name, pid, ago, mon) =>
    `• ${name}#${pid}（${ago}活跃${mon}）`,
  monitoringSuffix: "，监控中",
  closed: (count, body, summary) =>
    `${count === 1 ? "已关闭 session:" : `已关闭 ${count} 个 session:`}\n${body}\n\n${summary}`,
  closeFailedLine: (name, pid) =>
    `✗ ${name} (pid ${pid}) — 进程可能已退出，已从列表移除`,
  closeOkLine: (name, pid) => `✓ ${name} (pid ${pid})`,
  remainingSummary: (total, monitored) =>
    `剩余 ${total} 个 session，其中 ${monitored} 个监控中。`,
  runEnded: (name, mins, task) =>
    `任务 session "${name}" 已结束（运行 ${mins} 分钟）。\n任务: ${task}\n\n如果没有收到结果消息，任务可能中途失败，可发 /run 重试或回电脑查看。`,
  unreadWarn: (name) =>
    `提醒: 发给 "${name}" 的消息已 2 分钟未被读取。该 session 可能没有在监控消息。\n发送 /sessions 查看状态，或用 /s <编号> <消息> 换一个 session。`,
  sessionsHeader: (count) => `活跃 sessions (${count}):`,
  // Laid out for a phone: ~24 CJK characters per line, single newlines kept.
  // One field per line so nothing wraps mid-field; emoji act as field labels.
  // WeChat on desktop collapses single newlines to spaces, and the same text
  // still reads fine there because of those labels. Blank lines separate
  // entries in both.
  sessionEntry: (dot, n, label, tags, dir, ago, claude) =>
    [
      `${dot}【${n}】${label}${tags}`,
      `📁 ${dir}`,
      claude ? `🤖 ${claude}` : "",
      `⏱ ${ago}`,
    ]
      .filter(Boolean)
      .join("\n"),
  idleSection: (body) =>
    `💤 闲置（未监控、2 小时以上未活跃）\n\n${body}\n\n可发 /close idle 一键清理`,
  idleEntry: (n, label, ago, dir, claude) =>
    `○【${n}】${label} · ⏱ ${ago}\n📁 ${dir}${claude ? ` · 🤖 ${claude}` : ""}`,
  boundTag: " 📌 已绑定",
  defaultTag: " 📥 默认接收",
  monitoringTag: " 👀",
  legendBound: "📌 已绑定 = 你的消息都发到这里（/use off 取消）",
  legendDefault: "📥 默认接收 = 不带前缀的消息发到这里（/use <编号> 可固定绑定）",
  legendNumbers: "👀 监控中 · 📁 目录 · 🤖 Claude 会话名 · ⏱ 上次活跃",
  legendRoute: (example) =>
    `回复某个 session：/s <编号> <消息>\n例 /s ${example} 你好 · 编号固定不变`,
  versionLine: (version) => `📦 当前版本：wechat-claude @ v${version}`,
  updateAvailable: (current, latest) =>
    `⬆️ 有新版本 v${latest}（当前 v${current}）。在电脑上更新:\nnpm i -g wechat-claude-sessions@latest && wechat-claude daemon restart\n然后在各 Claude Code session 里 /mcp → wechat → Reconnect，再 /wechat 重新挂上。`,
  replyFooter: (name, n) =>
    n === undefined
      ? `—— 来自 ${name} · 直接回复: /s ${name} <消息>`
      : `—— 来自 ${name}（#${n}）· 直接回复: /s ${n} <消息>`,
  noRepoDirs: "  （无，可在 ~/.claude/wechat/config.json 配置 repoDirs）",
  usageLimited: (resetHint, waiting) =>
    `⚠️ Claude 用量已达上限，所有 session 现在都无法回复（不是掉线，消息已经收到了）。\n\n预计恢复: ${resetHint}\n${waiting}\n\n恢复后我会主动告诉你，并提醒 session 处理积压的消息。期间可以继续发消息，我会存好。\n发送 /usage 可随时查询。`,
  usageRecovered: (mins, pending) =>
    `✅ Claude 用量已恢复（受限 ${mins} 分钟）。${pending}`,
  usageNoteOnSend: (resetHint) =>
    `⚠️ 提醒: Claude 用量仍在上限中（预计 ${resetHint} 恢复），消息已存下，恢复后会处理。`,
  usageChecking: "正在检查 Claude 用量状态…",
  usageOk: "✅ Claude 用量正常，没有触发限制。\n如果 session 仍然不回，多半是它在忙或没有在监控消息，发送 /ls 看看。",
  usageStatusLimited: (resetHint, mins) =>
    `⚠️ Claude 用量已达上限（已持续 ${mins} 分钟）。\n预计恢复: ${resetHint}\n\n期间所有 session 都不会回复，消息会存下，恢复后再处理。`,
  usageUnknown: (detail) =>
    `没能确认用量状态（检查命令本身失败了）:\n${detail}\n\n可以到电脑上运行一次 claude -p ok 看看。`,
  usageResetUnknown: "未知",
  usageMacNotice: (resetHint) =>
    `Claude 用量已达上限，所有 session 暂停响应（预计恢复: ${resetHint}）`,
  usagePendingNudged: (count) =>
    `已提醒 ${count} 个 session 处理积压的消息。`,
  usagePendingNone: "没有待处理的消息。",
  usageWaitingList: (body) => `等待处理的消息:\n${body}`,
  cfgNotArray: "config.json 的 repoDirs 必须是字符串数组",
  cfgNonString: "config.json 的 repoDirs 含非字符串项，已跳过",
  cfgNotAbsolute: (d) => `config.json 的 repoDirs 项 "${d}" 不是绝对路径，已跳过`,
  cfgBadJson: "config.json 不是合法 JSON，repoDirs 配置未生效",
  loginExpired: "WeChat 登录已过期，请在 Claude Code 中重新扫码登录",
};

const en: Msgs = {
  help: [
    "🤖 wechat-claude commands",
    "",
    "👀 View",
    "/ls — list sessions",
    "/ls all — include idle ones",
    "",
    "💬 Chat",
    "/use 3 — bind #3; your messages all go there",
    "/use off — unbind",
    "/s 3 hi — send just this one to #3",
    "",
    "🚀 Run tasks",
    "/run fix login bug — start a Claude session (unattended by default)",
    "/run myapp run tests — pick a directory",
    "/run --safe <task> — bash commands need confirmation at the computer",
    "/runs — running tasks",
    "/stop 1 — stop by number, /stop all for all",
    "",
    "🧹 Clean up",
    "/close 3 — close #3",
    "/close idle — close all idle sessions",
    "/close myapp all — close all with that name",
    "",
    "🩺 Status",
    "/usage — check whether Claude's usage limit is blocking replies",
    "",
    "📌 Notes",
    "· Numbers are stable; select by number / name / pid",
    "· Plain messages go to your bound session (else the most recent monitoring one)",
    "· 📷 Send images directly — Claude can see them",
    "· 🎤 Voice is auto-transcribed to text",
  ].join("\n"),
  noSessions: "No active Claude sessions.",
  noSessionsDeliver: "No active Claude session — message can't be delivered.",
  sListUsage: "Usage: /s <number|name|pid> <message>\ne.g. /s 1 hello\nSend /sessions to see the list.",
  notFound: (sel) => `Can't find "${sel}". Send /sessions for the list.`,
  deliveredUnmonitored: (name) =>
    `Delivered to "${name}", but that session isn't monitoring messages (hasn't run /wechat), so it may not be handled promptly.`,
  deliveredNoneMonitored: (name) =>
    `Delivered to "${name}", but no session is monitoring messages (run /wechat in a Claude Code session), so it may not be handled promptly.`,
  bindingCleared: "The bound session closed; auto-unbound and delivered this message via default routing.",
  useBound: (name, pid, warn) =>
    `Bound to "${name}" (pid ${pid}). Your messages now go straight there.${warn}\n/use off to unbind.`,
  useNotMonitoredWarn: "\nNote: this session isn't monitoring messages; replies may lag.",
  useCurrent: (name, pid) =>
    `Bound to: "${name}" (pid ${pid}).\n/use off to unbind, /use <number|name|pid> to rebind.`,
  useNone: "No binding.\n/use <number|name|pid> — bind so all your messages go to that session\n/use off — unbind",
  useUnbound: "Unbound; back to default routing (most recent monitoring session).",
  runUsage:
    "Usage: /run [--safe] [dir] <task>\n\nUnattended by default (skips permission prompts). With --safe, only edits auto-apply; bash commands wait for confirmation at the computer.\n\ne.g.\n/run check the latest PR\n/run myapp run the tests and fix failures\n/run --safe /path/to/repo fix the bug",
  runDirNotFound: (dirHint, sessDirs, searchDirs, task, configNote) =>
    `Directory "${dirHint}" not found — cancelled (to avoid running in the wrong place).\n\nAvailable session dirs:\n${sessDirs}\n\nOr a project under these search dirs:\n${searchDirs}\n\nOr give an absolute path. If "${dirHint}" is task text, not a dir, use: /run . ${task}${configNote}`,
  runNoSession: "No active session — specify a directory.\nUsage: /run <dir> <task>",
  tmuxMissing: "tmux isn't installed, so an interactive session can't start. Run it manually at the computer.",
  runStarted: (cwd, task, perm, sessionName) =>
    `Started a Claude session\n\nDir: ${cwd}\nTask: ${task}\nPermissions: ${perm}\ntmux: ${sessionName}\n\nThe result will come back to WeChat.\n/runs to list, /stop ${sessionName} to cancel.\nAt the computer: tmux attach -t ${sessionName}`,
  runStartFailed: (err) => `Failed to start: ${err}`,
  bypassAutoAccepted:
    "Note: accepted Claude Code's skip-permissions mode in ~/.claude.json (bypassPermissionsModeAccepted). Without it a /run session stops at a one-time confirmation dialog that nobody is there to answer. One time only.",
  bypassUnavailable: (configFile) =>
    `Cannot start the task: ${configFile} could not be read or written, so skip-permissions mode is not confirmed as accepted. Launching anyway would hang on the consent dialog forever, so the run was cancelled.\n\nFix: run claude --dangerously-skip-permissions once at the computer and accept it, or use /run --safe <task>.`,
  permSkip: "skip confirmations (default)",
  permSafe: "auto-accept edits only (--safe)",
  runsNone: "No /run task sessions right now.",
  runsList: (count, body) =>
    `Running tasks (${count}):\n\n${body}\n\n/stop <number|name> to stop, /stop all for all\nAt the computer: tmux attach -t <name>`,
  runsEntry: (n, name, mins, task) =>
    `${n}. ${name} (started ${mins}m ago)\n   task: ${task}`,
  runsEntryBare: (n, name) => `${n}. ${name}`,
  stopNumOutOfRange: (n) => `Number ${n} is out of range. Send /runs for the list.`,
  stopNotFound: (sel) => `No running task "${sel}". Send /runs for numbers or names.`,
  stopped: (count, body) => `Stopped ${count} task(s):\n${body}`,
  stopFailed: "Stop failed — it may have already exited. Send /runs to check.",
  closeUsage:
    "Usage:\n/close <number|name|pid> — close a session\n/close <name> all — close all sessions with that name\n/close idle — close all idle sessions (unmonitored, idle 2h+)\n\nNote: closing kills the process; unsaved work in that session is lost. For /run tasks use /stop.",
  closeNoIdle: "No idle sessions (unmonitored and idle for 2h+).",
  closeAmbiguous: (sel, count, body) =>
    `"${sel}" matches ${count} sessions:\n\n${body}\n\nClose all: /close ${sel} all\nClose one: /close <pid>`,
  closeAmbiguousEntry: (name, pid, ago, mon) => `• ${name}#${pid} (${ago}${mon})`,
  monitoringSuffix: ", monitoring",
  closed: (count, body, summary) =>
    `${count === 1 ? "Closed session:" : `Closed ${count} sessions:`}\n${body}\n\n${summary}`,
  closeFailedLine: (name, pid) =>
    `✗ ${name} (pid ${pid}) — process may have exited; removed from the list`,
  closeOkLine: (name, pid) => `✓ ${name} (pid ${pid})`,
  remainingSummary: (total, monitored) =>
    `${total} session(s) left, ${monitored} monitoring.`,
  runEnded: (name, mins, task) =>
    `Task session "${name}" ended (ran ${mins}m).\nTask: ${task}\n\nIf you didn't get a result message, it may have failed midway — /run to retry or check at the computer.`,
  unreadWarn: (name) =>
    `Heads up: your message to "${name}" has been unread for 2 minutes. That session may not be monitoring.\nSend /sessions to check, or /s <number> <message> to pick another.`,
  sessionsHeader: (count) => `Active sessions (${count}):`,
  sessionEntry: (dot, n, label, tags, dir, ago, claude) =>
    [
      `${dot} [${n}] ${label}${tags}`,
      `📁 ${dir}`,
      claude ? `🤖 ${claude}` : "",
      `⏱ ${ago}`,
    ]
      .filter(Boolean)
      .join("\n"),
  idleSection: (body) =>
    `💤 Idle (unmonitored, 2h+ inactive)\n\n${body}\n\nSend /close idle to clean up`,
  idleEntry: (n, label, ago, dir, claude) =>
    `○ [${n}] ${label} · ⏱ ${ago}\n📁 ${dir}${claude ? ` · 🤖 ${claude}` : ""}`,
  boundTag: " 📌 bound",
  defaultTag: " 📥 default",
  monitoringTag: " 👀",
  legendBound: "📌 bound = your messages go here (/use off to unbind)",
  legendDefault: "📥 default = plain messages go here (/use <n> to pin)",
  legendNumbers: "👀 monitoring · 📁 directory · 🤖 Claude session name · ⏱ last active",
  legendRoute: (example) =>
    `Reply to one session: /s <n> <message>\ne.g. /s ${example} hello · numbers never change`,
  versionLine: (version) => `📦 Running version: wechat-claude @ v${version}`,
  updateAvailable: (current, latest) =>
    `⬆️ Update available: v${latest} (you have v${current}). On your computer:\nnpm i -g wechat-claude-sessions@latest && wechat-claude daemon restart\nthen in each Claude Code session: /mcp → wechat → Reconnect, and /wechat again.`,
  replyFooter: (name, n) =>
    n === undefined
      ? `—— from ${name} · reply directly: /s ${name} <message>`
      : `—— from ${name} (#${n}) · reply directly: /s ${n} <message>`,
  noRepoDirs: "  (none — configure repoDirs in ~/.claude/wechat/config.json)",
  usageLimited: (resetHint, waiting) =>
    `⚠️ Claude's usage limit is reached — no session can reply right now (nothing crashed; your message did arrive).\n\nExpected reset: ${resetHint}\n${waiting}\n\nI'll tell you as soon as it lifts and nudge the sessions to handle what piled up. Keep sending — messages are kept.\nSend /usage to check any time.`,
  usageRecovered: (mins, pending) =>
    `✅ Claude usage is back (limited for ${mins}m). ${pending}`,
  usageNoteOnSend: (resetHint) =>
    `⚠️ Note: Claude is still over its usage limit (reset ${resetHint}). Your message is saved and will be handled once it lifts.`,
  usageChecking: "Checking Claude usage…",
  usageOk: "✅ Claude usage is fine — no limit hit.\nIf a session still isn't replying it's probably busy or not monitoring; send /ls to check.",
  usageStatusLimited: (resetHint, mins) =>
    `⚠️ Claude's usage limit is reached (for ${mins}m now).\nExpected reset: ${resetHint}\n\nUntil then no session replies; messages are kept and handled afterwards.`,
  usageUnknown: (detail) =>
    `Couldn't determine usage status (the check itself failed):\n${detail}\n\nTry running claude -p ok at the computer.`,
  usageResetUnknown: "unknown",
  usageMacNotice: (resetHint) =>
    `Claude usage limit reached — all sessions are blocked (reset: ${resetHint})`,
  usagePendingNudged: (count) => `Nudged ${count} session(s) to handle the backlog.`,
  usagePendingNone: "Nothing was waiting.",
  usageWaitingList: (body) => `Messages waiting:\n${body}`,
  cfgNotArray: "config.json repoDirs must be an array of strings",
  cfgNonString: "config.json repoDirs has a non-string entry; skipped",
  cfgNotAbsolute: (d) => `config.json repoDirs entry "${d}" isn't an absolute path; skipped`,
  cfgBadJson: "config.json isn't valid JSON; repoDirs config was ignored",
  loginExpired: "WeChat login expired — re-scan the QR code in Claude Code",
};

export function t(lang: Lang = getLang()): Msgs {
  return lang === "en" ? en : zh;
}
