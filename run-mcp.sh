#!/bin/bash
# Brain MCP Server 启动脚本
# 用法: ./run-mcp.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/scripts/brain-mcp-server.js"
