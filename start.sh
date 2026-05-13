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

start_one() {
  local name="$1"
  local pid_file="$RUN_DIR/$name.pid"
  local log_file="$LOG_DIR/$name.log"
  shift

  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    echo "$name 已在运行，PID: $(cat "$pid_file")"
    return
  fi

  rm -f "$pid_file"
  nohup "$@" > "$log_file" 2>&1 &
  echo $! > "$pid_file"
  echo "$name 已启动，PID: $(cat "$pid_file")，日志: $log_file"
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
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      kill $pids 2>/dev/null || true
    fi
  fi
}

if [[ "${1:-start}" == "stop" ]]; then
  stop_one api 8787
  stop_one web 5173
  echo "服务已停止"
  exit 0
fi

if [[ "${1:-start}" == "restart" ]]; then
  stop_one api 8787
  stop_one web 5173
fi

start_one api npm run api
start_one web npm run dev

echo
echo "存储模式: MySQL"
echo "MySQL: ${MYSQL_USER:-<unset>}@${MYSQL_HOST:-<unset>}:${MYSQL_PORT:-<unset>}/${MYSQL_DATABASE:-<unset>}"
echo "访问地址: http://192.168.3.87:5173"
echo "停止服务: ./start.sh stop"
