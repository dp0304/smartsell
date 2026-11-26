#!/usr/bin/env bash
# SmartSell hub installer for macOS (§2.13).
#
#   curl -fsSL https://raw.githubusercontent.com/dp0304/smartsell/main/scripts/install-hub.sh | bash
#   # or, in a checkout: bash scripts/install-hub.sh
#   bash scripts/install-hub.sh --dir ~/smartsell --repo https://github.com/dp0304/smartsell.git --branch main
#
# The script checks prerequisites and prints the exact command for anything missing; it never installs system
# software for you. Every failing step prints the command, the reason and the next step, then stops.
set -u

REPO_URL="https://github.com/dp0304/smartsell.git"
BRANCH="main"
TARGET_DIR="${HOME}/smartsell"
SERVICE_MODE=""
DRY_RUN=0

usage() {
  cat <<'USAGE'
用法：bash scripts/install-hub.sh [--dir <原始碼資料夾>] [--repo <git 網址>] [--branch <分支>] [--mode agent|daemon] [--check-only]
  --dir        原始碼放在哪裡（預設 ~/smartsell；若在原始碼資料夾內執行，則使用目前的資料夾）
  --repo       原始碼來源（預設 GitHub：https://github.com/dp0304/smartsell.git；中國大陸可用 Gitee：https://gitee.com/yueshutech/smartsell.git）
  --branch     分支（預設 main）
  --mode       服務模式：agent（預設，登入後執行）或 daemon（無人登入也能執行，需要 sudo）
  --check-only 只檢查前置軟體，不做任何變更
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET_DIR="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --mode) SERVICE_MODE="$2"; shift 2 ;;
    --check-only) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不認得的參數：$1"; usage; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
fail() {
  # fail <command> <reason> <next step>
  printf '\n[失敗] 命令：%s\n       原因：%s\n       下一步：%s\n' "$1" "$2" "$3" >&2
  exit 1
}
run() {
  # run <description> <next step> -- <command...>
  local description="$1" next="$2"; shift 3
  printf '    $ %s\n' "$*"
  "$@" || fail "$*" "${description}失敗（結束碼 $?）" "$next"
}

if [ "$(uname -s)" != "Darwin" ]; then
  fail "uname -s" "這個安裝腳本只支援 macOS" "Windows 請改用 scripts/install-hub.ps1；Linux 請依 docs/hub-setup.md 手動安裝"
fi

step "1/6 檢查前置軟體"
missing=0
need() {
  # need <name> <probe command> <install command>
  if eval "$2" >/dev/null 2>&1; then
    printf '    [OK] %s\n' "$1"
  else
    printf '    [缺少] %s：請執行  %s\n' "$1" "$3"
    missing=1
  fi
}
need "Homebrew" "command -v brew" '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
need "git" "command -v git" "xcode-select --install   （或 brew install git）"
need "Node.js 24" "command -v node && node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) === 24 ? 0 : 1)'" "brew install node@24 && brew link --overwrite --force node@24"
need "corepack" "command -v corepack" "brew install node@24   （Node 24 內建 corepack）"
need "ffmpeg / ffprobe" "command -v ffprobe" "brew install ffmpeg"
need "Tailscale" "test -x /Applications/Tailscale.app/Contents/MacOS/Tailscale || command -v tailscale" "從 App Store 安裝 Tailscale 並登入（或 brew install --cask tailscale）"
if command -v node >/dev/null 2>&1; then
  current="$(node -p 'process.versions.node' 2>/dev/null)"
  case "$current" in 24.*) ;; *) printf '    目前的 Node 版本是 %s，需要 24：brew install node@24 && brew link --overwrite --force node@24\n' "$current" ;; esac
fi
if [ "$missing" -ne 0 ]; then
  fail "前置軟體檢查" "缺少上面標示的軟體" "依上面的命令安裝後，重跑 bash scripts/install-hub.sh"
fi
[ "$DRY_RUN" -eq 1 ] && { echo; echo "前置軟體都已安裝（--check-only，沒有做任何變更）。"; exit 0; }

step "2/6 啟用 pnpm（corepack）"
run "corepack enable" "以 sudo corepack enable 重試，或 npm install -g corepack" -- corepack enable

step "3/6 取得原始碼"
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd)"
if [ -n "$here" ] && [ -f "$here/apps/server/hub.ts" ] && [ -d "$here/.git" ]; then
  TARGET_DIR="$here"
  echo "    使用目前的原始碼資料夾：$TARGET_DIR"
  run "git pull" "先處理本機修改（git status），再重跑" -- git -C "$TARGET_DIR" pull --ff-only
elif [ -d "$TARGET_DIR/.git" ]; then
  run "git pull" "先處理本機修改（git -C \"$TARGET_DIR\" status），再重跑" -- git -C "$TARGET_DIR" pull --ff-only
else
  run "git clone" "確認網路與 --repo 網址後重跑" -- git clone --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
fi
cd "$TARGET_DIR" || fail "cd $TARGET_DIR" "無法進入原始碼資料夾" "確認 --dir 後重跑"

step "4/6 安裝相依套件、建置 Web 與 relay"
run "pnpm install" "看上面的錯誤訊息；網路問題時重跑即可" -- pnpm install --frozen-lockfile
run "Web 建置" "看上面的錯誤訊息，或在 docs/hub-setup.md 查「Web 建置失敗」" -- pnpm --filter @smartsell/web build
run "relay 建置" "看上面的錯誤訊息；修正後重跑 pnpm --filter @smartsell/agent-relay build" -- pnpm --filter @smartsell/agent-relay build

step "5/6 設定中樞（pnpm hub:init）"
run "pnpm hub:init" "依上面的提示處理後重跑 pnpm hub:init（可以重跑，已有的設定會保留）" -- pnpm hub:init --skip-web-build --no-service

step "6/6 安裝為服務（pnpm hub:service install）"
if [ -n "$SERVICE_MODE" ]; then
  run "pnpm hub:service install" "依上面的說明處理後重跑 pnpm hub:service install --mode $SERVICE_MODE" -- pnpm hub:service install --mode "$SERVICE_MODE"
else
  run "pnpm hub:service install" "依上面的說明處理後重跑 pnpm hub:service install" -- pnpm hub:service install
fi

echo
echo "完成。之後的健檢：pnpm hub:doctor；更新：pnpm hub:update。首次設定網址已印在上面 [10/10] 那一行。"
