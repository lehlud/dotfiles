# install dependencies
sudo apt install build-essential cmake vim-nox python3-dev mono-complete golang nodejs default-jdk npm --assume-yes

# compile ycm
python3 ~/.vim/plugged/youcompleteme/install.py --all
