#!/bin/bash

if [ "$EUID" -ne 0 ]
  then echo "Please run as root!"
  exit
fi

if [ ! -f /etc/pacman.d/mirrorlist.backup ] ; then
    echo "creating /etc/pacman.d/mirrorlist.backup ..."
	cp /etc/pacman.d/mirrorlist /etc/pacman.d/mirrorlist.backup
fi

echo "Ranking servers ..."
curl -s "https://www.archlinux.org/mirrorlist/?country=DE&country=FR&country=GB&country=NL&protocol=https&use_mirror_status=on" | sed -e 's/^#Server/Server/' -e '/^#/d' | rankmirrors -n 500 - > /etc/pacman.d/mirrorlist

