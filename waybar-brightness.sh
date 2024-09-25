#!/bin/bash

print_status() {
  echo "$(light -G | xargs printf %.0f)%" " " 
}

print_status

if [ -z "$1" ] || [ "$1" -ne "once" ]; then
  while sleep 0.1; do
    print_status
  done
fi


