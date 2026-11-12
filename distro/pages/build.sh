#!/bin/sh
# Builds the static (GitHub Pages) site into dist/pages/ from the repository root. Needs Python 3 with Pillow (pip install pillow).
set -e
cd "$(dirname "$0")/../.."
python3 tools/build-pages.py "$@"
echo "Publish the contents of dist/pages/ (see distro/pages/README.md)."
