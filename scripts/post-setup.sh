#!/bin/bash

sudo rm -f /etc/systemd/system/display-manager.service
sudo systemctl enable gdm --now


