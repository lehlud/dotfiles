#!/usr/bin/env python3

import sys
import json
import time
import argparse
import subprocess

LIMIT = 23

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--player', type=str, required=True)
    return parser.parse_args()

def query_status(player: str) -> str:
    try:
        return subprocess.check_output(["playerctl", "-p", player, "status"], stderr=subprocess.DEVNULL).decode().strip().lower()
    except:
        return 'no players found'

def query_metadata(player: str) -> dict[str, str]:
    try:
        raw = subprocess.check_output(["playerctl", "-p", player, "metadata"], stderr=subprocess.DEVNULL).decode().strip()
    except:
        return {}

    results = {}
    for line in raw.split('\n'):
        line = line[line.index(' ')+1:]
        key = line[:line.index(' ')].strip()
        value = line[line.index(' ')+1:].strip()
        results[key] = value

    return results

def write_text(player: str, text: str, last_text = str | None) -> str:
    if text == last_text: return text

    sys.stdout.write(json.dumps({
        "text": text,
        "class": player,
        "alt": player
    }))
    sys.stdout.write('\n')
    sys.stdout.flush()

    return text

def print_info(player: str, last_text = str | None) -> str | None:
    status = query_status(player)
    if status == 'no players found':
        if last_text is not None:
            sys.stdout.write('\n')
            sys.stdout.flush()
        return None

    metadata = query_metadata(player)
    artist = metadata.get('xesam:artist')
    title = metadata.get('xesam:title').replace("&", "&amp;")
    album = metadata.get('xesam:album')

    icon = '' if status == 'playing' else ''

    text = f'{title} ‒ {artist}' if artist and title else title
    if len(text) > LIMIT:
        text = text[:LIMIT] + '…'

    text = f'󰎇 {icon} {text}'
    
    return write_text(player, text, last_text)

    

def main():
    args = parse_args()

    sys.stdout.write('\n')
    sys.stdout.flush()

    try:
        text = None
        while True:
            try: text = print_info(args.player, text)
            except: pass
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
