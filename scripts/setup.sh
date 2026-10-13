#!/bin/bash
# scripts/setup.sh
#
# Creates the DeepJSON directories, dj.config and access.json (one admin user).
#
# Usage: bash scripts/setup.sh [--force]
#   --force   replace existing config files (old ones are kept as .bak)
#
# Environment:
#   DJ_ADMIN_PASSWORD   admin password; if unset, a random one is printed once
#   DJ_CONFIG_DIR       default /etc/deepjson
#   DJ_DATA_DIR         default /var/lib/deepjson
#   SERVER_USER         account the server runs as; default: the user who ran the
#                       script (also when it was started with sudo)

# Needs bash: under sh (dash, busybox) the brace expansion below would silently misbehave.
if [ -z "${BASH_VERSION:-}" ]; then
    echo "Please run this script with bash: bash scripts/setup.sh" >&2
    exit 1
fi

# Stop at the first failure.
set -euo pipefail

# Configuration
CONFIG_DIR="${DJ_CONFIG_DIR:-/etc/deepjson}"
DATA_DIR="${DJ_DATA_DIR:-/var/lib/deepjson}"
SERVER_USER="${SERVER_USER:-${SUDO_USER:-${USER:-$(id -un)}}}"
# Primary group (on macOS "staff", not the user name).
SERVER_GROUP="$(id -gn "$SERVER_USER")"

# Repository root, so the script works from any directory.
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

FORCE=0
if [ "${1:-}" = "--force" ]; then
    FORCE=1
fi

# Use sudo only when a target is not writable by the current user.
needs_root() {
    local dir="$1"
    while [ ! -e "$dir" ]; do dir="$(dirname "$dir")"; done
    [ ! -w "$dir" ]
}
SUDO=""
if needs_root "$CONFIG_DIR" || needs_root "$DATA_DIR"; then
    SUDO="sudo"
fi

random_hex() {
    node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"
}

# Generate secrets first, so a failure leaves nothing half-written.
JWT_SECRET="$(random_hex 32)"
DEVICE_SECRET="$(random_hex 32)"
if [ -n "${DJ_ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD="$DJ_ADMIN_PASSWORD"
    PRINT_PASSWORD=0
else
    ADMIN_PASSWORD="$(random_hex 12)"
    PRINT_PASSWORD=1
fi
# Passwords in access.json are stored as scrypt hashes, never plaintext.
ADMIN_PASSWORD_HASH="$(node "$REPO_DIR/bin/hash-password.js" "$ADMIN_PASSWORD")"

# Create directories and hand them to the service user.
$SUDO mkdir -p "$CONFIG_DIR" "$DATA_DIR"/{data,index,logs,scripts}
$SUDO chown -R "$SERVER_USER:$SERVER_GROUP" "$CONFIG_DIR" "$DATA_DIR"
$SUDO chmod 0750 "$CONFIG_DIR" "$DATA_DIR"
$SUDO chmod 0700 "$DATA_DIR"/data  # Sensitive data directory

# Writes stdin to $1 unless it exists (and no --force); sets WRITE_RESULT.
# Not used inside $(...): bash 3.2 on macOS ignores set -e there.
write_config() {
    local target="$1"
    if [ -e "$target" ] && [ "$FORCE" -eq 0 ]; then
        cat > /dev/null
        WRITE_RESULT="kept"
        return
    fi
    if [ -e "$target" ]; then
        $SUDO cp -p "$target" "$target.bak"
    fi
    $SUDO tee "$target" > /dev/null
    $SUDO chown "$SERVER_USER:$SERVER_GROUP" "$target"
    WRITE_RESULT="written"
}

# Session settings must be top-level; the server ignores them when nested.
write_config "$CONFIG_DIR/dj.config" <<EOL
{
  "data_root": "$DATA_DIR",
  "access_file": "$CONFIG_DIR/access.json",
  "port": 3000,
  "jwt_secret": "$JWT_SECRET",
  "payload_limit": "50mb",
  "index_depth": 3,
  "ssl": {
    "enabled": false,
    "port": 8443,
    "key": "/path/to/ssl.key",
    "cert": "/path/to/ssl.crt"
  },
  "emptySessionTTL": 60000,
  "maxClientsPerSession": 10,
  "allowMultipleSessionConnections": true,
  "preventDuplicateSessionConnections": false
}
EOL
CONFIG_RESULT="$WRITE_RESULT"

# Sample device: disabled, random secret, no users. Enable it deliberately.
write_config "$CONFIG_DIR/access.json" <<EOL
{
  "devices": {
    "sensor-123": {
      "id": "sensor-123",
      "secret": "$DEVICE_SECRET",
      "enabled": false,
      "allowed_ips": ["192.168.1.0/24"],
      "user_list": []
    }
  },
  "hmac_auth_settings": {
    "device_auth_enabled": false,
    "hmac_window": 300
  },
  "users": {
    "admin": {
      "id": "admin",
      "password": "$ADMIN_PASSWORD_HASH",
      "email": "admin@example.com",
      "groups": ["superadmin"]
    }
  },
  "groups": {
    "superadmin": {
      "id": "superadmin",
      "rules": [
        {
          "regex": ".*",
          "crudx": "11111"
        }
      ]
    }
  }
}
EOL
ACCESS_RESULT="$WRITE_RESULT"

# Set permissions for configuration files
$SUDO chmod 0640 "$CONFIG_DIR/access.json"
$SUDO chmod 0600 "$CONFIG_DIR/dj.config"

# No index file: the server creates dj.index itself.

echo "DeepJSON server setup complete!"
echo "  $CONFIG_DIR/dj.config: $CONFIG_RESULT"
echo "  $CONFIG_DIR/access.json: $ACCESS_RESULT"
if [ "$CONFIG_RESULT" = "kept" ] || [ "$ACCESS_RESULT" = "kept" ]; then
    echo "  Existing files were left as they are. Re-run with --force to replace them."
fi
if [ "$ACCESS_RESULT" = "written" ] && [ "$PRINT_PASSWORD" -eq 1 ]; then
    echo ""
    echo "Generated admin password (shown only once): $ADMIN_PASSWORD"
fi
echo ""
echo "Next steps:"
echo "1. Change the admin password if needed: node $REPO_DIR/bin/hash-password.js <new-password>"
echo "   then paste the resulting scrypt:... value into $CONFIG_DIR/access.json"
echo "2. Start the server as $SERVER_USER: node $REPO_DIR/main.js $CONFIG_DIR/dj.config"
