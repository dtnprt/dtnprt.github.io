#!/bin/sh
# FootCtrlPlus Web Config launcher for Linux and macOS.
# Serves this folder on http://localhost:8000. Serving over http (instead of opening the file directly)
# lets the browser remember the pedal for "Reconnect".
#
#   ./start.sh            (PORT=8080 ./start.sh for another port)

cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8000}"
URL="http://localhost:$PORT/"

if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else
  echo "Python 3 is required to serve the page (https://www.python.org/)." >&2
  exit 1
fi

echo "FootCtrlPlus Web Config"
echo "Open $URL in Chrome, Edge or another Chromium-based browser"
echo "(Firefox and Safari have no Web Bluetooth). Press Ctrl+C to stop."
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Linux: if Connect says Web Bluetooth is unavailable, enable chrome://flags/#enable-experimental-web-platform-features"
fi
echo

"$PY" -m http.server "$PORT" --bind 127.0.0.1
