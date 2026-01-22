#!/usr/bin/env bash

killall hyprpaper &> /dev/null

files=($HOME/.local/share/wallpapers/*)
filepath="${files[RANDOM % ${#files[@]}]}"

configpath="/tmp/hyprpaper-$USER.conf"

{
  echo "ipc = on"
  echo "splash = false"
  echo
  echo "wallpaper {"
  echo "  monitor = "
  echo "  path = $filepath"
  echo "}"
  echo
} > "$configpath"

hyprpaper -c "$configpath"

