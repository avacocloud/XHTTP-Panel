#!/usr/bin/env bash
# ─────────────────────────────────────────────
#  xhttp-info  —  XHTTP Panel management CLI
#  Usage: xhttp-info [reset-password|set-path]
# ─────────────────────────────────────────────

PORT="${PANEL_PORT:-3000}"
BASE="http://127.0.0.1:$PORT/api/v1/local"

# ANSI colors
R='\033[0;31m' G='\033[0;32m' Y='\033[0;33m'
B='\033[0;34m' C='\033[0;36m' W='\033[1;37m' N='\033[0m'

# ── helpers ──────────────────────────────────

die() { echo -e "${R}✗ $*${N}" >&2; exit 1; }

check_panel() {
  curl -sf "$BASE/info" -o /dev/null 2>/dev/null || \
    die "Panel is not running. Start it with: pm2 start xhttp-panel"
}

get_info() {
  curl -sf "$BASE/info" 2>/dev/null
}

parse() { echo "$1" | grep -o "\"$2\":\"[^\"]*\"" | cut -d'"' -f4; }

# ── screens ──────────────────────────────────

show_header() {
  local INFO; INFO=$(get_info)
  local WEB_PATH PANEL_URL LOCAL_URL
  WEB_PATH=$(parse "$INFO" webPath)
  PANEL_URL=$(parse "$INFO" panelUrl)
  LOCAL_URL=$(parse "$INFO" localUrl)

  echo ""
  echo -e "${W}╔══════════════════════════════════════════════╗${N}"
  echo -e "${W}║          XHTTP Panel — Management            ║${N}"
  echo -e "${W}╠══════════════════════════════════════════════╣${N}"
  printf  "${W}║${N}  ${C}%-10s${N} %s\n" "URL:"   "$PANEL_URL"
  printf  "${W}║${N}  ${C}%-10s${N} /%s\n" "Path:"  "$WEB_PATH"
  printf  "${W}║${N}  ${C}%-10s${N} %s\n" "Local:" "$LOCAL_URL"
  echo -e "${W}╚══════════════════════════════════════════════╝${N}"
  echo ""
}

do_reset_password() {
  echo -e "${Y}New password (min 6 chars):${N}"
  read -rsp "> " PASS; echo ""
  [[ ${#PASS} -ge 6 ]] || die "Password too short (min 6 chars)"

  local RES
  RES=$(curl -sf -X POST "$BASE/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"password\":$(printf '%s' "$PASS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" 2>/dev/null)

  echo "$RES" | grep -q '"ok":true' \
    && echo -e "${G}✓ Password changed successfully${N}" \
    || die "Failed: $RES"
}

do_set_path() {
  echo -e "${Y}New web path (4–32 chars, a-z 0-9 _ -)${N}"
  read -rp "> " NEW_PATH

  [[ "$NEW_PATH" =~ ^[a-z0-9_-]{4,32}$ ]] || \
    die "Invalid path — only lowercase letters, numbers, _ and -"

  local RES
  RES=$(curl -sf -X POST "$BASE/set-web-path" \
    -H "Content-Type: application/json" \
    -d "{\"path\":\"$NEW_PATH\"}" 2>/dev/null)

  if echo "$RES" | grep -q '"ok":true'; then
    echo -e "${G}✓ Web path changed to: /${NEW_PATH}${N}"
    echo -e "${Y}Restart panel to apply: pm2 restart xhttp-panel${N}"
  else
    die "Failed: $RES"
  fi
}

main_menu() {
  show_header
  echo -e "  ${W}[1]${N} Reset admin password"
  echo -e "  ${W}[2]${N} Change web path"
  echo -e "  ${W}[q]${N} Quit"
  echo ""
  read -rp "Choice: " CHOICE

  case "$CHOICE" in
    1) do_reset_password ;;
    2) do_set_path ;;
    q|Q) exit 0 ;;
    *) echo -e "${R}Invalid choice${N}" ;;
  esac
}

# ── entry point ──────────────────────────────

check_panel

case "${1:-}" in
  reset-password) do_reset_password ;;
  set-path)       do_set_path ;;
  info)           show_header ;;
  *)              main_menu ;;
esac
