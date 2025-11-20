#!/bin/sh

LID_STATE=$(cat /proc/acpi/button/lid/*/state)

case "$LID_STATE" in
  *open) ACTION="enable" ;;
  *closed) ACTION="disable" ;;
  *) echo "unable to identify lid state"; exit ;;
esac

swaymsg output "eDP-1" $ACTION
