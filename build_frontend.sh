#!/bin/sh
# 前端 Static Site 构建脚本（Render 在构建阶段执行）。
# 作用：把后端 Web Service 的地址注入 static/config.js，前端据此跨域请求 API。
# API_BASE 是 Static Site 服务上的环境变量，填后端地址，如 https://firmoo-exam-api.onrender.com
echo "window.API_BASE = '${API_BASE}';" > static/config.js
echo "generated static/config.js -> window.API_BASE = '${API_BASE}'"
