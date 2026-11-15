#!/bin/sh
# Fetches the X11 tools the desktop prototype runs, without root and without
# installing anything: Ubuntu's own packages, downloaded by apt (which checks
# them against the signed archive indices) and extracted into the user's
# ~/.local/opt. On an Environment, Machines would install the same packages.
#
#   sh fetch-tools.sh            # into ~/.local/opt/lazurio-desktop-prototype
#
# The prototype finds them there (or under $LAZURIO_DESKTOP_TOOLS; an empty
# value means "take them from PATH").
set -eu
root="${LAZURIO_DESKTOP_TOOLS:-$HOME/.local/opt/lazurio-desktop-prototype/root}"
debs="$(dirname "$root")/debs"
mkdir -p "$debs" "$root"
cd "$debs"
apt-get download x11vnc libvncserver1 libvncclient1 xdotool libxdo3 x11-utils libxxf86dga1 libxft2
for f in ./*.deb; do dpkg -x "$f" "$root"; done
missing=$(LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu" ldd "$root/usr/bin/x11vnc" "$root/usr/bin/xdotool" | grep "not found" || true)
if [ -n "$missing" ]; then
  echo "missing libraries:" >&2
  echo "$missing" >&2
  exit 1
fi
echo "tools in $root/usr/bin"
