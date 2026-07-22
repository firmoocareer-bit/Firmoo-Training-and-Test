#!/bin/sh
# 前端 Static Site 构建脚本（Render 在构建阶段执行）。
# 作用：把后端 Web Service 的地址注入 static/config.js，前端据此跨域请求 API。
# API_BASE 是 Static Site 服务上的环境变量。Render 的 fromService:property=host 只给服务名
# （如 firmoo-exam-api），需补成完整 https://<name>.onrender.com。
API_BASE="${API_BASE}"
if [ -n "$API_BASE" ]; then
  case "$API_BASE" in
    http://*|https://*)
      # 已是完整 URL；但若主机名无点（裸服务名），补 .onrender.com
      _host="${API_BASE#*://}"
      case "$_host" in
        *.*) ;;
        *) API_BASE="${API_BASE}.onrender.com" ;;
      esac
      ;;
    *.*) API_BASE="https://$API_BASE" ;;          # 形如 firmoo-exam-api.onrender.com
    *)   API_BASE="https://$API_BASE.onrender.com" ;; # 裸服务名 firmoo-exam-api
  esac
fi
STAMP="2026-07-17.37"
echo "window.API_BASE = '${API_BASE}';" > static/config.js
echo "window.BUILD_STAMP = '${STAMP}';" >> static/config.js
echo "generated static/config.js -> API_BASE='${API_BASE}', BUILD_STAMP='${STAMP}'"
