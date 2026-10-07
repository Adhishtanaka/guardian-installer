#!/bin/sh
# curl -fsSL https://raw.githubusercontent.com/Adhishtanaka/guardian-installer/main/install.sh | sudo sh
# Extra args go after "-s --": ... | sudo sh -s -- install --id <ID>
set -e
command -v node >/dev/null 2>&1 || { echo "Guardian needs Node.js 18+ first: https://nodejs.org"; exit 1; }
dir=$(mktemp -d)
[ $# -eq 0 ] && set -- install
trap 'rm -rf "$dir"' EXIT
curl -fsSL https://raw.githubusercontent.com/Adhishtanaka/guardian-installer/main/guardian-install.mjs -o "$dir/guardian-install.mjs"
# stdin is this script when piped, so give the installer the terminal for its Y/n prompt
if [ -r /dev/tty ]; then node "$dir/guardian-install.mjs" "$@" </dev/tty
else node "$dir/guardian-install.mjs" "$@" --yes; fi
