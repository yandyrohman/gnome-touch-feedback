#!/usr/bin/env bash
# Pasang extension ke user yang sedang login (atau TARGET_USER kalau dijalankan sebagai root).
set -euo pipefail
cd "$(dirname "$0")"
UUID=touch-feedback@yandi
if [ "$(id -u)" = 0 ]; then USER_NAME=${TARGET_USER:-${SUDO_USER:-root}}; else USER_NAME=$(id -un); fi
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
DEST="$HOME_DIR/.local/share/gnome-shell/extensions/$UUID"

as_user() {
    if [ "$(id -un)" = "$USER_NAME" ]; then "$@"
    else sudo -u "$USER_NAME" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u "$USER_NAME")/bus" "$@"; fi
}

as_user mkdir -p "$DEST"
as_user rsync -a --delete "$UUID/" "$DEST/"

current=$(as_user gsettings get org.gnome.shell enabled-extensions)
if [[ "$current" != *"$UUID"* ]]; then
    if [ "$current" = "@as []" ]; then new="['$UUID']"; else new="${current%]}, '$UUID']"; fi
    as_user gsettings set org.gnome.shell enabled-extensions "$new"
fi

echo "Terpasang di $DEST"
echo "Logout lalu login lagi biar GNOME baca versi barunya (Wayland nggak bisa reload extension)."
