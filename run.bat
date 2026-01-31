@echo off
cd /d "%~dp0"
echo ============================================================
echo              CLAUDE CODE PROXY - OpenAI Compatible
echo ============================================================
echo.
echo Endpoints:
echo   - Anthropic Native:  http://localhost:42069/v1/messages
echo   - OpenAI Compatible: http://localhost:42069/v1/chat/completions
echo   - Models List:       http://localhost:42069/v1/models
echo.
echo ------------------------------------------------------------
echo  SillyTavern Setup:
echo ------------------------------------------------------------
echo   1. Go to API Connections
echo   2. Select "Chat Completion" as API
echo   3. Select "Custom (OpenAI-compatible)" as Chat Completion Source
echo   4. Set Custom Endpoint: http://localhost:42069/v1
echo   5. Leave API Key empty (or put any value)
echo   6. Click "Connect" then select a model
echo.
echo ------------------------------------------------------------
echo  Janitor AI Setup:
echo ------------------------------------------------------------
echo   1. Go to Settings ^> API
echo   2. Select "OpenAI" or "Custom OpenAI"
echo   3. Set API URL: http://localhost:42069/v1
echo   4. Leave API Key empty (or put any value)
echo   5. Set Model: claude-sonnet-4-20250514 (or any Claude model)
echo.
echo ------------------------------------------------------------
echo  Available Models:
echo ------------------------------------------------------------
echo   GPT Names (mapped to Claude Sonnet 4):
echo     - gpt-4, gpt-4-turbo, gpt-4o, gpt-3.5-turbo
echo.
echo   Claude Models (recommended - short aliases):
echo     - claude-opus-4-5   (Claude 4.5 Opus)
echo     - claude-opus-4     (Claude 4 Opus)
echo     - claude-sonnet-4   (Claude 4 Sonnet)
echo     - claude-3-5-sonnet (Claude 3.5 Sonnet)
echo     - claude-3-5-haiku  (Claude 3.5 Haiku)
echo.
echo   Or use dated versions (e.g., claude-opus-4-5-20250514)
echo   Any model name is passed through directly to Anthropic!
echo.
echo ============================================================
echo  Starting server...
echo ============================================================
echo.
node server/server.js
echo.
echo ============================================================
echo  Server stopped. Press any key to close...
echo ============================================================
pause >nul
