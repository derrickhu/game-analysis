#!/usr/bin/env bash
# 与 asset_manager/service.sh 一致的入口别名
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start.sh" "$@"
