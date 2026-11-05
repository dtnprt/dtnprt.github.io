@echo off
rem Serves the website (release page + Web Config) on http://localhost:8002.
rem Run tools\make_site.py first so website\firmware\ exists.
cd /d "%~dp0"
echo Chocolate Plus - open http://localhost:8002/ in Chrome or Edge. Ctrl+C to stop.
python -m http.server 8002 --bind 127.0.0.1
