#!/usr/bin/env python3
"""Copy your Muso library into a portable ZIP; originals are never changed."""
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backup import export_library

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python termux/export-android.py ~/storage/downloads/Muso-backup.zip')
    root = os.environ.get('MUSO_DATA_DIR', '~/.local/share/muso')
    count = export_library(root, sys.argv[1])
    print(f'Exported {count} songs, playlists, likes and listening history to {sys.argv[1]}. Originals unchanged.')
