# Chocolate Plus Web Config

Single-file browser editor for the Sinco **FootCtrlPlus** (and GAM-10, same FootControl2 layout),
reimplementing the configuration part of the CubeSuite Android app. Protocol and memory layout:
`../CubeSuite_analysis.md`.

```
index.html       the whole app: markup, CSS and JS in one file, no build step, no dependencies
start.bat        Windows launcher: serves this folder on http://localhost:8000 and prints the URL to open
start.sh         Linux / macOS launcher (same)
start.command    macOS: double-clickable in Finder, runs start.sh
test/test.html   automated tests for index.html
```

To publish it, put `index.html` on any static web host (GitHub Pages, Netlify, …). HTTPS is required for Web Bluetooth,
which these provide. The Android app (`../android`) embeds the same file.

> Not BLE-MIDI: the pedal's configuration channel is a custom GATT service
> (`ae40`, write `ae41`, notify `ae42`), so the app uses **Web Bluetooth** (Chrome/Edge only).

## Run

- **Double-click** `index.html` in Chrome or Edge, or
- **Run the launcher**: `start.bat` (Windows), `./start.sh` (Linux/macOS) or double-click `start.command` (macOS).
  It serves the page on `http://localhost:8000` (needs Python 3) and prints the URL; open it in Chrome or Edge. This is needed for *Reconnect*: the browser
  only remembers granted devices for http(s) origins, not `file://`. Use `PORT=8080 ./start.sh` for another port.
- **Hosted**: any HTTPS URL works the same way as localhost.

Linux: Chrome needs `chrome://flags/#enable-experimental-web-platform-features` for Web Bluetooth.
macOS: give the browser Bluetooth access in System Settings → Privacy & Security → Bluetooth. If `start.command`
won't run after copying, run `chmod +x start.sh start.command` once.

Buttons:
- **Connect pedal**: browser device chooser (filters `FootCtrl*`, `GAM-10*`, service `ae40`; tick
  *show all BLE devices* if it's missing). Reads the whole 23646-byte configuration.
- **Reconnect …**: connects to a previously chosen pedal without scanning. This is needed when the pedal is paired
  with Windows, because then Windows keeps it connected and it stops advertising. It requires
  `edge://flags/#enable-web-bluetooth-new-permissions-backend` (or `chrome://flags/…`) and an http(s) origin (launcher or hosted).
- **Simulated pedal** (or `?demo` in the URL): in-page fake device for trying the editor.
- **Write changes** sends only modified byte ranges. **Auto-send** writes 0.4 s after each edit.
- **Import / Export .fcp**: same raw 23646-byte format as the CubeSuite app.
- **Keep-alive**: sends a name/version query every 10 s.

## Pedal disconnects after ~30 s

The pedal asks to pair, and Edge on Windows doesn't answer for an unpaired device, so the link drops at the
Bluetooth pairing timeout (the page explains this when it happens). Pair it once in Windows Settings →
Bluetooth & devices, then use *Reconnect* as above. The Android app doesn't have this problem.

## Code layout (inside index.html)

The `<script>` is one IIFE with these sections, in order:

| Section | Content |
|---|---|
| CC / command tables | names for the custom-control lists, from CubeSuite `Global.java` |
| Protocol | `00 59 cmd len24 payload chk` framing, response matchers, `Client` (read 1000-byte / write 173-byte chunks) |
| Transports | `BleLink` (Web Bluetooth), `NativeLink` (Android bridge, `window.AndroidBle` ↔ `window.__ble`) |
| FootControl2 layout | offsets of every field (`OFF`, `advAddr`, `mixAddr`, …), labels, `MockLink` simulated pedal |
| UI | rendering, editors, transfer logic |

`window.__fc2` exposes the internals for the tests.

## Tests

```sh
python -m http.server 8000      # in this folder
# open http://localhost:8000/test/test.html  -> "ALL PASSED"
```

The tests cover protocol frames (checked against the Java implementation), layout offsets, read/write round
trips against the simulated pedal, the UI in every mode, and the Android bridge with a fake `AndroidBle`.

## Caveats

- If a 188-byte frame can't be written in one go (small MTU), the app falls back to 20-byte writes. Whether the
  firmware accepts frames split like that is unverified.
- Tick *show TX/RX bytes* in the log to see raw traffic.
- The older **FootCtrl** model (1858-byte layout) is not supported.
