#!/usr/bin/env bash

print_status() {
  free -m | awk '/^Mem:/ {printf "%.2f GiB  \n", $3 / 1024}'
}

print_status

if [ -z "$1" ] || [ "$1" -ne "once" ]; then
  while sleep 0.1; do
    print_status
  done
fi


