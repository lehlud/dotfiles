#!/usr/bin/env bash

killall hyprpaper &> /dev/null

files=($HOME/.local/share/wallpapers/*)
filepath="${files[RANDOM % ${#files[@]}]}"

configpath="/tmp/hyprpaper-$USER.conf"

echo "preload = $filepath" > "$configpath"
echo "wallpaper = , $filepath" >> "$configpath"
echo "splash = false" >> "$configpath"

hyprpaper -c "$configpath"

