#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT_DIR/run"
LOG_DIR="$ROOT_DIR/logs"

mkdir -p "$RUN_DIR" "$LOG_DIR"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

# 锁定时区到 Asia/Shanghai：toLocalDateKey 与 first_seen_date 都依赖服务器本地时区，
# 容器/CI 默认 UTC 会让广东时间晚上 8 点后的事件被切到第二天，导致 CPI/ROI 与运营录入对不齐。
export TZ="${TZ:-Asia/Shanghai}"

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
    echo "$name 已在运行，PID: $(cat "$pid_file")"
    return
  fi

  if write_pid_from_port "$name" "$port"; then
    echo "$name 端口 $port 已在监听，PID: $(cat "$pid_file")"
    return
  fi

  rm -f "$pid_file"
  nohup "$@" >> "$log_file" 2>&1 < /dev/null &
  echo $! > "$pid_file"
  sleep 1

  if write_pid_from_port "$name" "$port"; then
    echo "$name 已启动，PID: $(cat "$pid_file")，日志: $log_file"
    return
  fi

  echo "$name 启动失败：端口 $port 未监听，请查看日志: $log_file" >&2
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

  if [[ -n "$port" ]] && command -v lsof >/dev/null 2>&1; then
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
    echo "$name 运行中，端口: $port，PID: ${pids//$'\n'/,}"
    echo "$pids" | head -n 1 > "$pid_file"
    return
  fi
  rm -f "$pid_file"
  echo "$name 未运行，端口: $port"
}

case "${1:-start}" in
  status)
    status_one api 8787
    status_one web 5173
    exit 0
    ;;
  stop)
    stop_one api 8787
    stop_one web 5173
    echo "服务已停止"
    exit 0
    ;;
  restart)
    stop_one api 8787
    stop_one web 5173
    ;;
  start)
    ;;
  *)
    echo "用法: $0 [start|stop|restart|status]" >&2
    exit 1
    ;;
esac

start_one api 8787 npm run api
start_one web 5173 npm run dev

echo
echo "存储模式: MySQL"
echo "MySQL: ${MYSQL_USER:-<unset>}@${MYSQL_HOST:-<unset>}:${MYSQL_PORT:-<unset>}/${MYSQL_DATABASE:-<unset>}"
echo "访问地址: http://192.168.3.87:5173"
echo "停止服务: ./start.sh stop"
