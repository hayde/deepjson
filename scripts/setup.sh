#!/bin/bash
# scripts/setup.sh

# Configuration
CONFIG_DIR="/etc/deepjson"
DATA_DIR="/var/lib/deepjson"
SERVER_USER="$USER"  # Change this to your service user if different

# Create directories with proper permissions
sudo mkdir -p "$CONFIG_DIR" "$DATA_DIR"/{data,index,logs,scripts}
sudo chown -R $SERVER_USER:$SERVER_USER "$DATA_DIR"
sudo chmod 0750 "$CONFIG_DIR" "$DATA_DIR"
sudo chmod 0700 "$DATA_DIR"/data  # Sensitive data directory

# Create default configuration file
sudo tee "$CONFIG_DIR/dj.config" > /dev/null <<EOL
{
  "data_root": "$DATA_DIR",
  "access_file": "$CONFIG_DIR/access.json",
  "port": 3000,
  "jwt_secret": "REPLACE_WITH_STRONG_SECRET",
  "payload_limit": "50mb",
  "index_depth": 3,
  "ssl": {
    "enabled": false,
    "key": "/path/to/ssl.key",
    "cert": "/path/to/ssl.crt"
  },
  "socketServer": {
    "preventDuplicateSessionConnections": false,
    "allowMultipleSessionConnections": true,
    "maxClientsPerSession": 10
  }
}
EOL

# Passwords in access.json are stored as scrypt hashes, never plaintext.
# Generate one for the default admin account (change it after first login).
ADMIN_PASSWORD_HASH=$(node "$(dirname "$0")/bin/hash-password.js" "CHANGE_ME")

# Create sample access.json
sudo tee "$CONFIG_DIR/access.json" > /dev/null <<EOL
{
  "devices": {
    "sensor-123": {
      "id": "sensor-123",
      "secret": "d12e8a9f-5b3a-4c8d-b7e1-2f3a9b8c7d6a",
      "enabled": true,
      "allowed_ips": ["192.168.1.0/24"],
      "valid_until": "2025-12-31",
      "user_list": [".*"]
    }
  },
  "hmac_øauth_settings": {
    "device_auth_enabled": true,
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

# Set permissions for configuration files
sudo chown $SERVER_USER:$SERVER_USER "$CONFIG_DIR"/*
sudo chmod 0640 "$CONFIG_DIR"/*.json
sudo chmod 0600 "$CONFIG_DIR/dj.config"

# Create initial index file
sudo -u $SERVER_USER tee "$DATA_DIR/index/dj.index" > /dev/null <<EOL
# Initial DeepJSON index file
# Format: key|hash|created|modified|modCount
EOL

echo "DeepJSON server setup complete!"
echo "Next steps:"
echo "1. Edit $CONFIG_DIR/dj.config and set proper JWT secret"
echo "2. Change the default admin password: node bin/hash-password.js <new-password>"
echo "   then paste the resulting scrypt:... value into $CONFIG_DIR/access.json"
echo "3. Start server with: node /path/to/server/main.js $CONFIG_DIR/dj.config"