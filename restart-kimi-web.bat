@echo off
kimi server kill
timeout /t 3 /nobreak >nul
cd /d "D:\workspace\kimi-code-memory-mcp-server"
start "" cmd /c "kimi web"
