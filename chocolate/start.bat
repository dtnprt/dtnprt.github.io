@echo off
rem Serves the configurator on http://localhost:8000 (needed for "Reconnect" / remembered pedals).
cd /d "%~dp0"
echo FootCtrlPlus Web Config
echo Open http://localhost:8000/ in Chrome or Edge. Press Ctrl+C to stop.
echo.
python -m http.server 8000 --bind 127.0.0.1
