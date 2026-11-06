# Ampero II Stomp – Web-Editor

Neuimplementierung der Hotone-Software im Browser (Web MIDI, ohne Build-Schritt, ohne Abhängigkeiten).
Erste Funktion: **alle Presets sichern** (und – sobald der Schreibbefehl bekannt ist – wiederherstellen).

## Starten

Web MIDI mit SysEx gibt es nur in **Chrome/Edge** und nur in einem „sicheren Kontext“ (https oder localhost):

```
python -m http.server 8000 -d web
```

→ <http://localhost:8000>, MIDI-Zugriff erlauben, **Hotone-Editor schließen** (Windows-MIDI-Ports sind
exklusiv), *Connect*.

## Seiten

* **Edit** – Presetliste wie in der Hotone-Software mit Ansicht *All* / *Style* (Gruppen Rock … Acoustic,
  „No style“, „Not read yet“) und Kontextmenü (Rechtsklick oder ☰): *Import Patch* (`.prst`/`.raw` in den Slot
  schreiben), *Export Patch* (`.prst`/`.raw`), *Rename…*, *Style ▸*. Schreiben = `0x01000001` + Zurücklesen;
  Lesen/Schreiben lädt den Slot am Gerät, danach wird das vorher aktive Preset wieder gewählt.
  Der Editorbereich ist ein **Mockup** (zeigt nur die Module des aktuellen Presets, wenn es bekannt ist).
* **Backup & Restore** – siehe unten.
* **Global Settings** – **Mockup**.
* **Sniffer** – Mitschnitte ansehen: live (nur zuhören; verbunden = eigener Verkehr beider Richtungen, sonst nur
  was das Gerät sendet), App-Traces (`.txt`) und Wireshark/USBPcap-`.pcapng` (beide Richtungen, auch
  Drag & Drop). Liste mit bekannten/unbekannten Befehlen, Filter, Feldbaum + farbiger Hexdump (Klick verknüpft
  beide), Rohframes mit Header-Feldern, Speichern als Trace.

Der Stil steht im Preset (Tag 1, Offset 91). Die Namensliste `0x01080000` enthält ihn nach bisherigem Stand
nicht erkennbar; die App kennt ihn daher nur für Presets, die sie in dieser Sitzung gelesen hat (Backup,
Export, Umbenennen, Gerät schickt den Dump beim Umschalten) – *Read all styles* liest den Rest (~3 min).
Das Modell (Stomp/Stage/Mini) zeigt die App nach dem Verbinden anhand des MIDI-Portnamens an.

## Backup

*Backup presets* liest A00-1 … A99-3 einzeln (`0x01000000` mit `u32 index`) und speichert eine ZIP-Datei:

```
manifest.json                         Format (Version 2), Firmware, Datum, pro Preset: index, label, name,
                                      scenes, file, size + crc32 (des entpackten TLV-Presets)
presets/A00-1-Ampero Strikes!.prst    ein Preset im Exportformat der Hotone-Software (base64 ← JSON-Bytearray
presets/A00-2-Slick Drive.prst        ← LZO ← TLV, 5068 Byte) – byte-identisch zu deren Export, lässt sich dort
…                                     direkt importieren
preset_list.bin                       Antwort auf 0x01080000 (Namensliste), unverändert
```

Ältere Sicherungen (Version 1, `presets/NNN_A00-1_Name.raw` mit dem TLV direkt) werden weiterhin gelesen –
von der App und von `ampero_preset.py`.

**Hotone-Software vorher schließen!** Beim ersten Test lief sie im Hintergrund und sprach gleichzeitig mit
dem Gerät (Windows liefert die Antworten offenbar an beide Programme): Im Trace
(`debug/ampero_trace_2026-11-06-08-06-00.txt`) stehen ihre Abfragen `03000001`/`010a0003`, und in 15 von
1347 Frames fehlten 1–5 Byte. Ohne die Software lief das Backup fehlerfrei. Die App warnt, sobald
`010a0003` ankommt (fragt nur die Hotone-Software ab), und erkennt gekürzte Frames (Länge ≠ Header) und
fragt dann neu an.

**Lesen lädt das Preset:** Ein Dump per Index (`0x01000000`) schaltet das Gerät auf dieses Preset um –
auch ohne Hotone-Software (am Gerät bestätigt). Ungespeicherte Änderungen gehen dabei verloren; die App
wählt am Ende das vorher aktive Preset wieder aus.

Ansehen ohne Entpacken:

```
python tools/ampero_preset.py decode Ampero_Backup_….zip                   # Liste: Slot, Name, Szenen, Effekte
python tools/ampero_preset.py decode Ampero_Backup_….zip --preset A02-1    # ein Preset
python tools/ampero_preset.py convert Ampero_Backup_….zip --preset A02-1 -o juicy.prst
```

## Restore

*Open backup…* → Slots auswählen → *Restore selected*. Pro Slot sendet die App wie der Hotone-Editor
`0x01000001` (`u32 slot` + TLV, 183-Byte-Frames, ~40 ms Abstand), wartet auf die Quittung `0x06000000`
und liest den Slot zurück. „ok (verified)“ = byte-identisch. Nie gespeicherte „Empty“-Slots liegen im
alten Format (Tag 1 `version` = 2, Tag 2 Byte 3–5 = `FF FF FF`); beim Schreiben speichert das Gerät sie als
Version 3 mit `00 00 00` – das wird als „ok (empty preset, stored in current format)“ angezeigt (185 von 300
Slots im Test). Jede andere Abweichung zeigt die Tabelle mit Byte-Anzahl. Am Ende wird das vorher aktive
Preset wieder ausgewählt.

## Aktualisierung

Das Gerät meldet Änderungen am Gerät selbst (Preset-Wechsel, Umbenennen, Speichern) nicht. Die App fragt
deshalb jede Sekunde das aktuelle Preset und die Szene ab und alle 10 s die Namensliste (lädt kein Preset);
sofort neu gelesen wird, wenn ein anderes Programm etwas gespeichert hat (das Gerät leitet dessen Befehle
und Quittungen weiter), beim Zurückkehren ins Browserfenster und über *↻ Current* / *↻ All*. Während Backup
und Restore ruht die Abfrage.

Belegt durch `debug/start-software-and-restore.pcapng`: Die App erzeugt die Schreib-Frames des Editors
byte-identisch (Test). Der erste echte Schreibtest der App sollte in einen leeren Slot gehen.

## Tests

```
python tools/gen_web_fixtures.py        # Referenzdaten aus lzo1x.py und windows/wireshark.pcapng
python -m http.server 8000 -d web       # → http://localhost:8000/test/test.html
```

Prüft: LZO-Kompression byte-identisch zu `tools/lzo1x.py` (= Editor), alle 50 Host-Nachrichten des
Mitschnitts byte-identisch, Reassemblierung aller Geräteantworten, Preset-/Namensliste-Parser, ZIP und
Backup-Roundtrip.

## Aufbau

| Datei | Inhalt |
|---|---|
| `js/lzo1x.js` | LZO1X-Dekompression und -Kompression (Port von `tools/lzo1x.py`) |
| `js/protocol.js` | SysEx-Rahmen, Reassembler, Befehlscodes, TLV-/Namensliste-Parser |
| `js/device.js` | Web-MIDI-Verbindung: Handshake wie der Editor, Anfrage/Antwort mit Timeout und Wiederholung |
| `js/zip.js`, `js/backup.js` | Sicherungsdatei schreiben/lesen |
| `js/app.js`, `index.html`, `css/app.css` | Oberfläche |
