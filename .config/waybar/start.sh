#!/usr/bin/env bash

cd "$(dirname "$0")"

ls * | entr -r sh -c 'killall waybar; waybar &'
