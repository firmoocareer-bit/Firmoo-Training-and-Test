#!/bin/sh
# 前端 Static Site 构建脚本（Render 在构建阶段执行）。
# 作用：把后端 Web Service 的地址注入 static/config.js，前端据此跨域请求 API。
# API_BASE 是 Static Site 服务上的环境变量，Render 的 fromService:property=host 只给 hostname，
# 这里自动补成 https:// 完整地址。
API_BASE="${API_BASE}"
if [ -n "$API_BASE" ]; then
  case "$API_BASE" in
    http://*|https://*) ;;
    *) API_BASE="https://$API_BASE" ;;
  esac
fi
echo "window.API_BASE = '${API_BASE}';" > static/config.js
echo "generated static/config.js -> window.API_BASE = '${API_BASE}'"
