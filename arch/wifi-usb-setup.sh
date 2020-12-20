#!/usr/bin/bash
cd ~/Downloads
git clone https://github.com/cilynx/rtl88x2bu.git
sudo dkms add ./rtl88x2bu
sudo dkms install rtl88x2bu/5.6.1
echo "Please to reboot to apply these changes to your system!"

