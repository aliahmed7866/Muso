#!/usr/bin/env python3
"""Export Muso's Termux library with automatic data-folder detection."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backup import main

if __name__ == '__main__':
    main()
