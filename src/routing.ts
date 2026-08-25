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
        `Binding: ${userId} → ${label(target)} — plain messages from this user will NOT arrive in this session. In WeChat, send "/use off" to unbind, or "/use <n>" (see /ls) to bind a different session.`
      );
    }
  }

  const def = getDefaultTarget(sessions);
  if (def) {
    lines.push(
      `Default target for unbound plain messages: ${label(def)}${def.id === selfId ? " (this session)" : ""}`
    );
  }
  return lines;
}
