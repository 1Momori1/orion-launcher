"""Патч live backend: каналы выката, telemetry, rollback, metrics."""
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "tmp-launcher-releases.py"
# python3 scripts/rollout-server.py path/to/launcher_releases.py

if __name__ == "__main__":
    import sys
    dest = Path(sys.argv[1] if len(sys.argv) > 1 else "launcher_releases.py")
    dest.write_text(SRC.read_text(encoding="utf-8"), encoding="utf-8")
    print("wrote", dest)
