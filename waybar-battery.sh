#!/bin/bash

print_status() {
  echo $(upower -i /org/freedesktop/UPower/devices/battery_BAT0 | grep percentage | sed 's/percentage://g') " " 
}

print_status

if [ -z "$1" ] || [ "$1" -ne "once" ]; then
  while sleep 1; do
    print_status
  done
fi


