#!/usr/bin/env bash
# 安裝 /team skill 到 Claude Code，並檢查各模型的 CLI。
# Installs the /team skill into Claude Code and checks which model CLIs are available.
set -euo pipefail

HOME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/team"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 需要 Node.js 18 以上 / Node.js 18+ is required: https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js $(node -v) 太舊，需要 18 以上 / Node.js 18+ is required" >&2
  exit 1
fi

mkdir -p "$SKILL_DIR"
if [ -f "$SKILL_DIR/SKILL.md" ]; then
  cp "$SKILL_DIR/SKILL.md" "$SKILL_DIR/SKILL.md.bak"
  echo "• 已備份原本的 /team skill / Backed up existing skill → $SKILL_DIR/SKILL.md.bak"
fi

# 把 skill 裡的 {{ORCHESTRA_HOME}} 換成這個資料夾的實際路徑
ORCHESTRA_HOME="$HOME_DIR" node -e '
  const fs = require("fs");
  const [src, dst] = process.argv.slice(1);
  fs.writeFileSync(dst, fs.readFileSync(src, "utf8").replaceAll("{{ORCHESTRA_HOME}}", process.env.ORCHESTRA_HOME));
' "$HOME_DIR/skill/team/SKILL.md" "$SKILL_DIR/SKILL.md"
echo "✓ 已安裝 /team skill / Installed /team skill → $SKILL_DIR/SKILL.md"
echo

node "$HOME_DIR/orchestra/dispatch.mjs" doctor || true

cat <<EOF

下一步 / Next steps
  1. 在 Claude Code 開新對話，輸入 /team 加上任務，例如：/team 幫我把這個專案的測試補齊
     Open a new Claude Code session and type /team followed by a task.
  2. 儀表板 / Dashboard:  node "$HOME_DIR/orchestra/server.mjs"  →  http://localhost:4747
  3. 自動駕駛（選用）/ Autopilot (optional):  /team 設定自動駕駛
EOF
