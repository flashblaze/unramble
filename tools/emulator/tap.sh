#!/usr/bin/env bash
# tap.sh "<text or content-desc>" — taps the centre of the first matching UI node (dev test helper).
set -euo pipefail
adb shell uiautomator dump /sdcard/ui.xml >/dev/null
node=$(adb shell cat /sdcard/ui.xml | grep -oE "<node [^>]*(text|content-desc)=\"$1\"[^>]*>" | head -1)
[ -n "$node" ] || { echo "no node '$1'" >&2; exit 1; }
read -r x1 y1 x2 y2 < <(grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' <<<"$node" | tr -c '0-9\n' ' ')
adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
