#!/bin/sh

if [[ $(pactl get-sink-mute "@DEFAULT_SINK@") == *"yes" ]]; then
  volume="Mute"
else
  volume=$(pactl get-sink-volume "@DEFAULT_SINK@" | grep -Po '\d+%' | head -n 1)
fi

mem=$(free --mega | tail -2 | awk '{print s+=$3}' | tail -1 | awk '{printf "%.2f GB", $1/1000}')

cpu=$(grep 'cpu ' /proc/stat | awk '{usage=($2+$4)*100/($2+$4+$5)} END {printf "%.2f%", usage}')

bat_level=$(cat /sys/class/power_supply/BAT*/capacity)
bat_state=$(cat /sys/class/power_supply/BAT*/status)

date=$(date +'%d.%m.%Y %H:%M:%S')

status="Audio $volume | CPU $cpu | RAM $mem | $bat_level% $bat_state | $date"

wifi=$(nmcli -t -f name,type connection show --active | grep wireless | cut -d\: -f1)
if [[ -n $wifi ]]; then
  status="$wifi | $status"
fi

echo $status

