#!/usr/bin/env bash
# Stop and remove this project's containers and networks (only this project's: GWSYNTH_PROJECT, default gwsynth).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
[ -f "$ENV_FILE" ] || { echo "no env file: nothing of this project was started here"; exit 0; }
dc down -v --remove-orphans
