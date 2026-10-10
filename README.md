# DeepJSON

A JSON document database with built-in server-side scripting, real-time synchronization and binary file storage. One server replaces what typically takes a database, a file store, a scripting layer and a WebSocket service.

## Why DeepJSON

Most databases only store data. Everything else like scripting, file handling, real-time sync and access control must be handled separately. DeepJSON handles all of it in a single process with two config files.

Most startups start with a database and quickly add an object store for files, an auth service and a cache or real-time layer. DeepJSON is a single process that covers all of them.

Security is handled natively. Authentication, permissions, token renewal and password hashing are all built into the server. With separate services, developers spend time wiring up auth layers, managing API keys between services and securing inter-service communication. With DeepJSON, security works out of the box and developers can focus on building features.

- **Server-side scripting**: send JavaScript alongside your request, executed in a sandboxed WebAssembly environment (QuickJS). No Lambda functions, no separate compute layer. The script runs against your data and returns the result in one round trip.
- **Real-time sync**: built-in WebSocket channels with master/client sessions. No need for a separate pub/sub service.
- **Binary file storage**: upload images, PDFs and documents as first-class keys. Images are served with on-the-fly resizing, cropping and format conversion.
- **CRUDX permissions**: regex-based access control. The X stands for eXecute: script execution is a separate permission, not bundled with read/write.
- **Zero-dependency connector**: the official [JavaScript client](https://github.com/hayde/deepjson-js-connector) runs in Node.js and the browser with no runtime dependencies. One `<script>` tag, no build step, no CDN.
- **Sliding session tokens**: every authenticated response silently renews the JWT. An active client never expires.

## When to use DeepJSON

DeepJSON works well as:

- A **backend for web and mobile apps** that need JSON storage, file uploads and real-time features without managing multiple services
- A **prototyping and rapid development database**: one server, one config file, full CRUD + scripting + sync out of the box
- A **startup backend** that replaces your database, file store, scripting layer and WebSocket service with a single process. Fewer moving parts, lower infra cost, faster time to market
- An **IoT data store** with HMAC device authentication and IP whitelisting
- A **collaborative application backend** with real-time channels for live editing, dashboards or multiplayer features
- A **self-hosted alternative** to Firebase, Supabase or MongoDB Atlas when you want full control over your data and infrastructure
- A **document and file management backend** with content-addressable storage and on-the-fly image processing

## Quick Start

### 1. Setup

```bash
# Clone the repository
git clone https://github.com/hayde/deepjson.git
cd deepjson

# Install dependencies
npm install

# Run the setup script (creates config and directories)
bash deepjson-server-setup.sh
```

The setup script creates:
- `/etc/deepjson/dj.config`: server configuration
- `/etc/deepjson/access.json`: users, groups and permissions
- `/var/lib/deepjson/`: data, index, logs and scripts directories

### 2. Configure

Edit `/etc/deepjson/dj.config`:

```json
{
  "data_root": "/var/lib/deepjson",
  "access_file": "/etc/deepjson/access.json",
  "port": 3000,
  "jwt_secret": "replace-with-a-strong-random-secret",
  "payload_limit": "50mb",
  "index_depth": 3
}
```

Set the admin password:

```bash
node bin/hash-password.js your-secure-password
# outputs: scrypt:<salt>:<hash>
```

Paste the result into `access.json` under the admin user's `password` field.

### 3. Start

```bash
node main.js /etc/deepjson/dj.config
```

### 4. Connect

Install the JavaScript connector:

```bash
npm install deepjson-connector
```

```javascript
const { Connector } = require('deepjson-connector');

const dj = new Connector({ baseURL: 'http://localhost:3000' });

// Login
await dj.login('admin', 'your-secure-password');

// Store data
await dj.post('users.alice', { name: 'Alice', role: 'engineer' });

// Read data
const user = await dj.get('users.alice');

// Check server connectivity and renew token
const { version } = await dj.version();

// Check your identity and permissions
const me = await dj.whoami(['users.alice']);
```

A [Python connector](https://pypi.org/project/deepjson-py-connector/) is also available:

```bash
pip install deepjson-py-connector
```

## Features

### Authentication

**JWT tokens**: login with username/password, receive a signed JWT. Every authenticated response includes a renewed token in the `X-Renewed-Token` header, automatically picked up by the connector. An active session never expires.

**HMAC device authentication**: for IoT devices and automated systems. Authenticate with a device ID, user, timestamp and HMAC-SHA256 signature. Supports IP whitelisting and device-specific user allowlists.

```
X-Device-Auth: {deviceId}:{timestamp}:{user}:{signature}
```

**Password security**: passwords are stored as scrypt hashes (`scrypt:<salt>:<hash>`), verified with constant-time comparison. Plaintext passwords are never stored.

**Live access changes**: `access.json` is read at startup and on `POST /admin/reload-access`, so adding a user or changing a permission needs no restart. A reload is all-or-nothing: the new file must parse and validate before it replaces anything, otherwise the running server keeps the access data it already had. Removing a user takes effect on their next request, even if they still hold a valid token.

### CRUDX Access Control

Permissions are defined per group with regex patterns matching key names. Each rule carries a 5-character CRUDX string:

| Position | Permission | Description |
|----------|-----------|-------------|
| 0 | **C**reate | POST new keys |
| 1 | **R**ead | GET existing keys |
| 2 | **U**pdate | PUT to existing keys |
| 3 | **D**elete | DELETE keys |
| 4 | e**X**ecute | Run server-side scripts |

Example `access.json`:

```json
{
  "users": {
    "alice": {
      "id": "alice",
      "password": "scrypt:<salt>:<hash>",
      "email": "alice@example.com",
      "groups": ["editors"]
    }
  },
  "groups": {
    "editors": {
      "rules": [
        { "regex": "^public\\..*", "crudx": "11110" },
        { "regex": "^drafts\\.alice\\..*", "crudx": "11111" }
      ]
    }
  }
}
```

Rules are evaluated in order: the **last matching rule wins**. This allows patterns like "access everything, except this subset."

### Server-Side Scripting

Send JavaScript code with any request. Scripts execute in a sandboxed QuickJS WebAssembly environment. No access to Node.js APIs, the filesystem or the network. Memory and execution time are capped.

```javascript
// Double every value in an array, server-side
const result = await dj.get('metrics.daily', null, `
  response = data.map(v => v * 2);
`);

// Transform data on write
await dj.put('reports.q3', { revenue: 50000 }, `
  data = { ...data, calculated_tax: body.revenue * 0.19, updated: new Date().toISOString() };
  response = data;
`);
```

Scripts receive a context object with:

| Variable | Description |
|----------|-------------|
| `data` | Current stored value of the key |
| `body` | Request body (parsed JSON) |
| `origin` | Full stored record including metadata |
| `user` | Authenticated user info |
| `key` | The key being accessed |
| `hash` | SHA-256 hash of the key |
| `http_method` | The HTTP method (GET, POST, PUT, DELETE) |
| `response` | Set this to control what the client receives |
| `custom` | Persistent custom metadata on the record |

The script engine is configurable. The default is `wasm` (QuickJS compiled to WebAssembly), chosen for its strong isolation: even a bug in the JS engine itself cannot reach the host Node.js process.

### Real-Time Channels

WebSocket-based sessions with a master/client model for live collaboration.

```javascript
const { SyncConnector } = require('deepjson-connector');

const sync = new SyncConnector({ baseURL: 'http://localhost:3000' });
await sync.login('alice', 'password');

// Create a session (you become the master)
const channelId = await sync.createSession();
// Share channelId with collaborators

// Others join with the channel ID
await sync.joinSession(channelId);

// Send messages to all participants
sync.send('cursor-move', { x: 100, y: 200, user: 'alice' });

// Receive messages
sync.on('cursor-move', (data) => {
  renderCursor(data.user, data.x, data.y);
});
```

Session features:
- Master/client roles: the master's disconnect ends the session
- Configurable max clients per session
- Duplicate connection prevention
- Automatic reconnection with token refresh
- Empty session TTL cleanup

### File Storage and Image Processing

Upload binary files (images, PDFs, documents) and retrieve them with optional on-the-fly transformations.

```javascript
// Upload
await dj.uploadFile('photos.vacation.sunset', file);

// Download original
const original = await dj.setBinary(true).get('photos.vacation.sunset');

// Download resized (query parameters)
// GET /keys/photos.vacation.sunset?binary&width=400&height=300&fit=cover&format=webp&quality=80
```

Supported image operations:

| Parameter | Values | Description |
|-----------|--------|-------------|
| `width` | pixels | Target width |
| `height` | pixels | Target height |
| `fit` | contain, cover, fill, inside, outside | Resize strategy |
| `alignX` | left, center, right | Horizontal crop position |
| `alignY` | top, center, bottom | Vertical crop position |
| `format` | jpeg, png | Output format conversion |
| `quality` | 1-100 | JPEG quality |
| `allowEnlarge` | true/false | Allow upscaling |

Images are automatically rotated based on EXIF orientation data.

### Wildcard Key Generation

Automatically generate unique keys on POST using wildcard patterns:

```javascript
// Auto-incrementing: creates tickets.1, tickets.2, tickets.3, ...
await dj.post('tickets.*{type:inc}', { title: 'Bug report' });

// Random UUID: creates logs.<uuid>
await dj.post('logs.*{type:random}', { event: 'user_signup' });
```

### Key Operations

**Move/Rename** with full permission checks and key history tracking:

```javascript
await dj.move('drafts.article-1', 'published.article-1');
```

The move operation verifies delete permission on the source, create/update permission on the target, supports wildcard destinations and records the move in the key's metadata history.

### Index System

DeepJSON maintains an append-only index log for fast key lookups without scanning the filesystem.

- **In-memory index**: backed by a persistent log file (`dj.index`)
- **Index rotation**: compaction with dated archive snapshots, on demand via `POST /admin/rotate-index` or periodically via `index_archiving.rotate_every_hours`
- **Retention policy**: configurable `older_than_days` for automatic archive cleanup
- **Rebuild from disk**: `POST /admin/rebuild-index` reconstructs the index from stored data files
- **Modification counter**: global counter for efficient sync polling

### Admin API

Admin routes require membership in the `admin` or `superadmin` group.

| Endpoint | Description |
|----------|-------------|
| `GET /admin/keys` | List all keys (filtered by caller's read permissions) |
| `GET /admin/health` | Server uptime, storage stats, modification counter |
| `GET /admin/modifications/:since` | Keys modified since a given counter value |
| `POST /admin/rebuild-index` | Reconstruct the index from data files on disk |
| `POST /admin/rotate-index` | Compact the index log, archive a snapshot, apply retention |
| `POST /admin/reload-access` | Re-read `access.json` without restarting. A file that does not parse or validate is refused with the specific problems, and the previous access data stays in effect |
| `GET /admin/logs` | Request logs from the past 7 days |

### Identity Endpoints

Both sit behind authentication, so they double as a connectivity check and token renewal.

| Endpoint | Description |
|----------|-------------|
| `GET /version` | Server version (from package.json). Lightweight heartbeat. |
| `GET /whoami` | Caller's identity, groups, admin status and rule list |
| `GET /whoami?keys=a,b` | Same, plus resolved CRUDX permissions for the requested keys |

## Configuration Reference

### Server config (`dj.config`)

| Field | Type | Description |
|-------|------|-------------|
| `data_root` | string | Root directory for data, index, logs, scripts |
| `access_file` | string | Path to access.json |
| `port` | number | HTTP listening port |
| `jwt_secret` | string | Secret for signing JWTs |
| `payload_limit` | string | Max request body size (e.g. `"50mb"`) |
| `index_depth` | number | Directory tree depth for content-addressable storage |
| `script_engine` | string | Script sandbox engine (`"wasm"`, default) |
| `script_execution_time_limit` | number | Max script runtime in ms (default: 5000) |
| `ssl.enabled` | boolean | Enable HTTPS |
| `ssl.key` | string | Path to SSL private key |
| `ssl.cert` | string | Path to SSL certificate |
| `ssl.port` | number | HTTPS listening port |
| `index_archiving.older_than_days` | number | Delete archived index snapshots older than this. Applied during a rotation, so it needs `rotate_every_hours` or a manual `POST /admin/rotate-index` to take effect |
| `index_archiving.rotate_every_hours` | number | Compact the index log every N hours. Omit to disable the schedule; the admin route stays available |
| `preventDuplicateSessionConnections` | boolean | Prevent same user joining a session twice |
| `allowMultipleSessionConnections` | boolean | Allow multiple connections per user per session |
| `maxClientsPerSession` | number | Maximum clients per real-time session |
| `emptySessionTTL` | number | Ms before an empty session is cleaned up |

## Architecture

```
Typical startup stack:

┌───────┐     ┌────────────────────┐
│       │────▶│  PostgreSQL        │  Database
│       │────▶│  S3 / GCS          │  File storage
│  App  │────▶│  Auth0 / Clerk     │  Authentication
│       │────▶│  Redis / Pusher    │  Real-time / cache
└───────┘     └────────────────────┘
               3-5 services · multiple configs

With DeepJSON:

┌───────┐     ┌────────────────────┐
│  App  │────▶│  DeepJSON          │  All of the above
└───────┘     └────────────────────┘
               1 process · 2 config files
```

```
deepjson/
├── main.js                  # Entry point, graceful shutdown
├── server.js                # DeepJSONServer class (Express + Socket.IO)
├── lib/
│   └── scriptEngines/
│       ├── index.js         # Engine factory (config-driven selection)
│       └── quickjs.js       # QuickJS/WASM sandbox
├── bin/
│   └── hash-password.js     # CLI tool for scrypt password hashing
├── deepjson-server-setup.sh # One-command server setup
└── test/                    # Tests (node:test, no external dependencies)
```

**Data storage layout:**

Keys are stored as JSON files in a content-addressable directory tree. The key name is SHA-256 hashed, and the first N bytes (configured by `index_depth`) determine the directory path:

```
/var/lib/deepjson/
├── data/          # Key-value data files (SHA-256 directory tree)
│   └── a1/b2/c3/  # Nested by hash prefix
│       └── <full-hash>  # JSON file
├── index/         # Append-only index log
│   ├── dj.index   # Live index
│   └── archive/   # Dated snapshots
├── logs/          # Daily request logs (YYYY-MM-DD.log)
└── scripts/       # Server-side scripts directory
```

## Connectors

| Connector | Install | Repository |
|-----------|---------|------------|
| JavaScript (Node.js + Browser) | `npm install deepjson-connector` | [deepjson-js-connector](https://github.com/hayde/deepjson-js-connector) |
| Python | `pip install deepjson-py-connector` | [deepjson-py-connector](https://github.com/hayde/deepjson-py-connector) |

## Testing

```bash
# Install dependencies
npm install

# Run tests
npm test
```

Tests use Node's built-in `node:test` runner. No test framework to install.

## Security

- Passwords stored as scrypt hashes with constant-time comparison
- JWT tokens with configurable expiry and automatic renewal
- Server-side scripts sandboxed in WebAssembly (no filesystem, network or Node.js API access)
- HMAC device authentication with replay protection (timestamp window) and IP whitelisting
- HSTS headers on HTTPS connections
- `X-Powered-By` header disabled
- CRUDX permission checks on every key operation

## Scaling

DeepJSON is designed for both horizontal and vertical scaling.

**Horizontal scaling**: the server is stateless by design. Data lives on the filesystem, not in process memory, so you can run multiple DeepJSON instances behind a load balancer pointing at the same shared storage (NFS, EFS, GlusterFS or any POSIX-compatible filesystem). Each instance reads the same `dj.config` and `access.json`, handles its own requests independently and writes to the same content-addressable directory tree. Add more instances to handle more concurrent connections, the data layer doesn't need to know about it.

**Vertical scaling**: the content-addressable storage distributes files across a configurable directory tree (controlled by `index_depth`). A depth of 3 creates up to 16 million leaf directories, avoiding filesystem bottlenecks even with millions of keys. The in-memory index provides O(1) key lookups regardless of dataset size, and the append-only index log minimizes write contention.

**Real-time channel scaling**: WebSocket sessions are managed per-instance in memory. For horizontal deployments with real-time features, sticky sessions (session affinity) at the load balancer ensure all participants in a channel connect to the same instance. This is the same pattern used by Socket.IO in clustered environments.

| Scaling strategy | How |
|-----------------|-----|
| More users / higher throughput | Add instances behind a load balancer (horizontal) |
| Larger datasets | Increase `index_depth` for deeper directory distribution |
| Bigger files / more storage | Expand or mount larger volumes at `data_root` |
| Real-time at scale | Sticky sessions per channel across instances |

## Comparison with Other Databases

> 🟢 Built-in / native &nbsp;&nbsp; 🟡 Partial / separate service &nbsp;&nbsp; 🔴 Not available

| Feature | DeepJSON | Firebase | MongoDB | Redis | Supabase |
|---------|:--------:|:--------:|:-------:|:-----:|:--------:|
| JSON document storage | 🟢 Native | 🟢 Native | 🟢 BSON | 🟢 Native | 🟡 JSONB |
| Server-side scripting | 🟢 WASM | 🟡 Separate | 🟡 Deprecated | 🟡 Lua | 🟡 Separate |
| Real-time sync | 🟢 WebSocket | 🟢 Built-in | 🟡 Streams | 🟡 Pub/Sub | 🟢 Built-in |
| Binary file storage | 🟢 Same API | 🟡 Separate | 🟡 GridFS | 🔴 | 🟡 Separate |
| Image processing | 🟢 Built-in | 🟡 Extension | 🔴 | 🔴 | 🟡 Storage |
| Self-hosted | 🟢 | 🔴 | 🟢 | 🟢 | 🟢 |
| Zero-dependency client | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| HMAC device auth | 🟢 | 🔴 | 🔴 | 🔴 | 🔴 |
| Sliding token renewal | 🟢 Auto | 🟡 Managed | 🔴 | 🔴 | 🟡 Managed |
| Permission model | CRUDX | Rules | RBAC | ACL | RLS |
| Setup complexity | 1 config | Console | Standalone | Config | Multi-svc |
| Horizontal scaling | Stateless | Managed | Sharding | Cluster | Managed |

## License

[Prosperity Public License 3.0.0](LICENSE). Free for non-commercial use. Commercial use is permitted for a 30-day trial period. See [LICENSE](LICENSE) for full terms.

## Contributing

Contributions are welcome. Please open an issue or pull request on [GitHub](https://github.com/hayde/deepjson).
