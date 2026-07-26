#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
#  游戏经分系统 - 服务管理脚本
#  用法: ./start.sh {start|stop|restart|status|log|install|uninstall}
#
#  重要：请用本脚本启动，不要用「npm run api / npm run dev」直接跑前台，
#  否则关闭终端后进程会被 SIGHUP 带走。本脚本使用 nohup 后台守护。
# ═══════════════════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT_DIR/run"
LOG_DIR="$ROOT_DIR/logs"
API_PORT="${GA_API_PORT:-8787}"
WEB_PORT="${GA_WEB_PORT:-5173}"
LAUNCHD_API_LABEL="com.dk.game-analysis-api"
LAUNCHD_WEB_LABEL="com.dk.game-analysis-web"
LAUNCHD_API_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_API_LABEL}.plist"
LAUNCHD_WEB_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_WEB_LABEL}.plist"

mkdir -p "$RUN_DIR" "$LOG_DIR"
cd "$ROOT_DIR"

# 不在 shell 中 source .env：其中的 JSON/Token 含引号，shell source 会把 JSON 引号吞掉。
# 后端/前端入口通过 dotenv 或 vite 自行读取 .env。

export TZ="${TZ:-Asia/Shanghai}"

NODE_BIN="$(command -v node || true)"
TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"
VITE_BIN="$ROOT_DIR/node_modules/.bin/vite"
if [[ -z "$NODE_BIN" || ! -x "$TSX_BIN" || ! -x "$VITE_BIN" ]]; then
  echo "未找到 Node 或依赖，请先在项目目录执行 npm install" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

get_lan_ip() {
  python3 -c "
import socket, re, subprocess
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2)
    s.connect(('8.8.8.8', 80))
    ip = s.getsockname()[0]
    s.close()
    if ip.startswith('192.168.') and not ip.startswith('192.168.255.'):
        print(ip); raise SystemExit
    if ip.startswith('10.'):
        print(ip); raise SystemExit
except Exception:
    pass
try:
    out = subprocess.run(['/sbin/ifconfig'], capture_output=True, text=True, timeout=3).stdout
    for pat in [r'inet (192\.168\.(?!255)\d+\.\d+)', r'inet (10\.\d+\.\d+\.\d+)']:
        m = re.search(pat, out)
        if m:
            print(m.group(1)); raise SystemExit
except Exception:
    pass
print('127.0.0.1')
" 2>/dev/null
}

port_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  fi
}

write_pid_from_port() {
  local name="$1"
  local port="$2"
  local pid_file="$RUN_DIR/$name.pid"
  local pids
  pids="$(port_pids "$port")"
  if [[ -n "$pids" ]]; then
    echo "$pids" | head -n 1 > "$pid_file"
    return 0
  fi
  return 1
}

is_pid_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

start_one() {
  local name="$1"
  local port="$2"
  local pid_file="$RUN_DIR/$name.pid"
  local log_file="$LOG_DIR/$name.log"
  shift 2

  if is_pid_running "$pid_file"; then
    echo "✅ $name 已在运行，PID: $(cat "$pid_file")"
    return 0
  fi

  if write_pid_from_port "$name" "$port"; then
    echo "✅ $name 端口 $port 已在监听，PID: $(cat "$pid_file")"
    return 0
  fi

  rm -f "$pid_file"
  echo "🚀 启动 $name (nohup 后台，端口 $port) ..."
  nohup "$@" >> "$log_file" 2>&1 < /dev/null &
  local new_pid=$!
  disown "$new_pid" 2>/dev/null || true
  echo "$new_pid" > "$pid_file"

  local listen_ok=0
  for _ in 1 2 3 4 5 6 8 10; do
    sleep 0.5
    if write_pid_from_port "$name" "$port"; then
      listen_ok=1
      break
    fi
  done

  if [[ "$listen_ok" -eq 1 ]]; then
    echo "✅ $name 已启动，PID: $(cat "$pid_file")，日志: $log_file"
    return 0
  fi

  echo "❌ $name 启动失败：端口 $port 未监听，请查看: $log_file" >&2
  rm -f "$pid_file"
  return 1
}

stop_one() {
  local name="$1"
  local pid_file="$RUN_DIR/$name.pid"
  local port="${2:-}"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    rm -f "$pid_file"
  fi

  if [[ -n "$port" ]]; then
    local pids
    pids="$(port_pids "$port")"
    if [[ -n "$pids" ]]; then
      kill $pids 2>/dev/null || true
    fi
  fi
}

status_one() {
  local name="$1"
  local port="$2"
  local pid_file="$RUN_DIR/$name.pid"
  local pids
  pids="$(port_pids "$port")"
  if [[ -n "$pids" ]]; then
    echo "● $name 运行中 | 端口 $port | PID ${pids//$'\n'/,}"
    echo "$pids" | head -n 1 > "$pid_file"
    return 0
  fi
  rm -f "$pid_file"
  echo "○ $name 未运行 | 端口 $port"
  return 1
}

do_log() {
  local name="${1:-api}"
  local lines="${2:-50}"
  local log_file="$LOG_DIR/$name.log"
  if [[ ! -f "$log_file" ]]; then
    echo "日志不存在: $log_file" >&2
    return 1
  fi
  echo "=== $name 最近 ${lines} 行 ($log_file) ==="
  tail -n "$lines" "$log_file"
}

do_follow() {
  local name="${1:-api}"
  local log_file="$LOG_DIR/$name.log"
  echo "=== 跟踪 $name 日志 (Ctrl+C 退出) ==="
  tail -f "$log_file"
}

launchd_path() {
  printf '%s:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' "$NODE_DIR"
}

do_install() {
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$LAUNCHD_API_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_API_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${TSX_BIN}</string>
        <string>src/server/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TZ</key>
        <string>Asia/Shanghai</string>
        <key>PATH</key>
        <string>$(launchd_path)</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/api.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/api.log</string>
</dict>
</plist>
EOF

  cat > "$LAUNCHD_WEB_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_WEB_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${VITE_BIN}</string>
        <string>--host</string>
        <string>0.0.0.0</string>
        <string>--port</string>
        <string>${WEB_PORT}</string>
        <string>--strictPort</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TZ</key>
        <string>Asia/Shanghai</string>
        <key>PATH</key>
        <string>$(launchd_path)</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/web.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/web.log</string>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/${LAUNCHD_API_LABEL}" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/${LAUNCHD_WEB_LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_API_PLIST"
  launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_WEB_PLIST"
  sleep 2
  echo "✅ 已安装 launchd 保活（登录自启 + 崩溃重启）"
  do_status
}

do_uninstall() {
  launchctl bootout "gui/$(id -u)/${LAUNCHD_API_LABEL}" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/${LAUNCHD_WEB_LABEL}" 2>/dev/null || true
  rm -f "$LAUNCHD_API_PLIST" "$LAUNCHD_WEB_PLIST"
  stop_one api "$API_PORT"
  stop_one web "$WEB_PORT"
  echo "✅ 已卸载 launchd 保活"
}

do_status() {
  echo ""
  echo "📊 游戏经分服务状态"
  echo "─────────────────────────────────────"
  status_one api "$API_PORT" || true
  status_one web "$WEB_PORT" || true
  echo "─────────────────────────────────────"
  echo "日志目录: $LOG_DIR"
  echo ""
}

launchd_loaded() {
  local label="$1"
  launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1
}

# 已 install launchd 时，普通 kill 会被 KeepAlive 立刻拉起旧/同配置进程；
# 改代码后必须 kickstart -k 才能让新源码生效。
do_restart_launchd() {
  local domain="gui/$(id -u)"
  if launchd_loaded "$LAUNCHD_API_LABEL"; then
    echo "🔄 launchd kickstart api ..."
    launchctl kickstart -k "${domain}/${LAUNCHD_API_LABEL}"
  else
    stop_one api "$API_PORT"
  fi
  if launchd_loaded "$LAUNCHD_WEB_LABEL"; then
    echo "🔄 launchd kickstart web ..."
    launchctl kickstart -k "${domain}/${LAUNCHD_WEB_LABEL}"
  else
    stop_one web "$WEB_PORT"
  fi
  sleep 1
  # 若未走 launchd，kickstart 分支不会启动，这里兜底 start
  do_start
}

do_stop() {
  local domain="gui/$(id -u)"
  # 若装了 launchd KeepAlive，先 bootout 再杀端口，否则杀完会被立刻拉起
  if launchd_loaded "$LAUNCHD_API_LABEL"; then
    echo "⏸ 临时卸下 launchd api（KeepAlive 不会再拉起）..."
    launchctl bootout "${domain}/${LAUNCHD_API_LABEL}" 2>/dev/null || true
  fi
  if launchd_loaded "$LAUNCHD_WEB_LABEL"; then
    echo "⏸ 临时卸下 launchd web（KeepAlive 不会再拉起）..."
    launchctl bootout "${domain}/${LAUNCHD_WEB_LABEL}" 2>/dev/null || true
  fi
  stop_one api "$API_PORT"
  stop_one web "$WEB_PORT"
  echo "✅ 服务已停止（若需开机自启，重新执行 ./start.sh install）"
}

do_start() {
  start_one api "$API_PORT" "$NODE_BIN" "$TSX_BIN" src/server/index.ts
  start_one web "$WEB_PORT" "$NODE_BIN" "$VITE_BIN" --host 0.0.0.0 --port "$WEB_PORT" --strictPort

  local lan_ip
  lan_ip="$(get_lan_ip)"
  echo ""
  echo "存储模式: MySQL（配置由 .env 加载）"
  echo "API:  http://127.0.0.1:${API_PORT}/api/health"
  echo "Web:  http://127.0.0.1:${WEB_PORT}"
  echo "局域网 Web: http://${lan_ip}:${WEB_PORT}"
  echo ""
  echo "停止: ./start.sh stop"
  echo "状态: ./start.sh status"
  echo "日志: ./start.sh log api | ./start.sh log web"
  echo "推荐: ./start.sh install  # 开机自启 + 崩溃保活"
}

case "${1:-start}" in
  start)
    do_start
    ;;
  stop)
    do_stop
    ;;
  restart)
    do_restart_launchd
    ;;
  status|st)
    do_status
    ;;
  log)
    do_log "${2:-api}" "${3:-50}"
    ;;
  follow|tail)
    do_follow "${2:-api}"
    ;;
  install)
    do_install
    ;;
  uninstall)
    do_uninstall
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|log|follow|install|uninstall}" >&2
    echo "  log api [n]   查看 API 最近 n 行日志" >&2
    echo "  log web [n]   查看 Web 最近 n 行日志" >&2
    exit 1
    ;;
esac
