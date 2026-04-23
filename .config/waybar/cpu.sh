#!/usr/bin/env bash

print_status() {
  top -bn1  | awk '/^%Cpu/ {printf "%02d%%  \n", 100 - $8}'
}

print_status

if [ -z "$1" ] || [ "$1" -ne "once" ]; then
  while sleep 0.1; do
    print_status
  done
fi


