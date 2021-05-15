#!/bin/bash

source setup.sh

# setup gnome
ipkg gnome
ipkg gnome-tweaks

# setup nvidia driver
wget -O ~/Downloads/nvidia-driver.run https://us.download.nvidia.com/XFree86/Linux-x86_64/460.80/NVIDIA-Linux-x86_64-460.80.run
sudo ~/Downloads/nvidia-driver.run
echo "sudo ~/Downloads/nvidia-driver.run" > ~/.profile
cat post-setup.sh >> ~/.profile
echo "\nrm ~/.profile\nsudo reboot" >> ~/.profile
sudo reboot

