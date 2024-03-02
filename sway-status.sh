#!/bin/sh

bat_level=$(cat /sys/class/power_supply/BAT*/capacity)
bat_state=$(cat /sys/class/power_supply/BAT*/status)

date=$(date +'%d.%m.%Y %H:%M:%S')

echo "$bat_level%" $bat_state "|" $date ""

