export interface UiAnchorHint {
  kind: "header_info" | "tag_cluster" | "button_cluster" | "action_menu" | "footer_actions";
  anchor: string;
  summary: string;
}

function normalizeContextLine(line: string): string {
  return line
    .replace(/^\s*\d+\s*\|\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUniqueHint(hints: UiAnchorHint[], nextHint: UiAnchorHint) {
  if (!nextHint.anchor) return;
  if (hints.some((item) => item.kind === nextHint.kind || item.anchor === nextHint.anchor)) return;
  hints.push(nextHint);
}

/**
 * 从组件快照中提取通用 UI 锚点提示。
 *
 * 它只关心“结构位置”，例如标签簇、按钮簇、下拉菜单区，
 * 不关心任何具体业务文案。
 */
export function extractUiAnchorHints(targetComponentContext: string): UiAnchorHint[] {
  const source = String(targetComponentContext || "").trim();
  if (!source) return [];

  const hints: UiAnchorHint[] = [];
  const lines = source.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = normalizeContextLine(rawLine);
    if (!line) continue;

    if (/<div class="user"|<div class='user'|<span class="username"|<label>/i.test(line)) {
      pushUniqueHint(hints, {
        kind: "header_info",
        anchor: line,
        summary: "组件头部主信息区，适合补充状态展示或高频入口。",
      });
    }

    if (/<el-tag\b|<tag\b|badge/i.test(line)) {
      pushUniqueHint(hints, {
        kind: "tag_cluster",
        anchor: line,
        summary: "现有标签/状态展示聚合区，适合扩展新的状态标识。",
      });
    }

    if (/<el-button\b|<button\b|<el-link\b|<a\b/i.test(line)) {
      pushUniqueHint(hints, {
        kind: "button_cluster",
        anchor: line,
        summary: "现有按钮或链接聚合区，适合挂接新的显式交互入口。",
      });
    }

    if (/<el-dropdown\b|<dropdown\b|<el-dropdown-menu\b|slot="dropdown"/i.test(line)) {
      pushUniqueHint(hints, {
        kind: "action_menu",
        anchor: line,
        summary: "现有菜单/更多操作区，适合作为二级交互入口。",
      });
    }

    if (/footer|action bar|showfootbutton|foot button/i.test(line)) {
      pushUniqueHint(hints, {
        kind: "footer_actions",
        anchor: line,
        summary: "组件底部动作区，适合补充流程尾部操作。",
      });
    }

    if (hints.length >= 5) break;
  }

  return hints.slice(0, 5);
}
