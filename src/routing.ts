import { listBindings } from "./bindings.js";
import {
  type SessionInfo,
  getDefaultTarget,
  listSessions,
  sessionLabel,
} from "./sessions.js";

// Human-readable summary of where plain (unrouted) WeChat messages currently
// go, from the point of view of one session. Surfaced by wechat_status so a
// session that starts monitoring can tell the user when a /use binding (or a
// busier default target) means messages will never arrive here — the failure
// is otherwise completely silent.
export function routingLines(selfId: string): string[] {
  const sessions = listSessions();
  const lines: string[] = [];
  const label = (s: SessionInfo): string =>
    `${sessionLabel(s, sessions)} (pid: ${s.pid})`;

  for (const [userId, boundId] of Object.entries(listBindings())) {
    const target = sessions.find((s) => s.id === boundId);
    if (!target) {
      lines.push(
        `Binding: ${userId} → session ${boundId} (stale — that session is gone; it is cleared on their next message)`
      );
    } else if (target.id === selfId) {
      lines.push(`Binding: ${userId} → this session`);
    } else {
      lines.push(
        `Binding: ${userId} → ${label(target)} — plain messages from this user will NOT arrive in this session. In WeChat, "/use <n>" (see /ls) binds a session; "/use off" only removes the binding, after which messages go to the default target.`
      );
    }
  }

  const def = getDefaultTarget(sessions);
  if (def) {
    // Spelled out rather than left as a bare fact: a session that reads
    // "default target: <someone else>" as one flat line tends to miss that
    // the user's plain messages are about to land elsewhere.
    lines.push(
      def.id === selfId
        ? `Default target for unbound plain messages: ${label(def)} (this session)`
        : `Default target for unbound plain messages: ${label(def)} — NOT this session. Unbound plain messages will NOT arrive here; they go to the most recently active monitored session. To receive them here, the user sends "/use <n>" in WeChat (see /ls), or this session becomes the most recent one to run /wechat with its watcher active.`
    );
  }
  return lines;
}
