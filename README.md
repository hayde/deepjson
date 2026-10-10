# DeepJSON

A JSON document database with built-in server-side scripting, real-time synchronization and binary file storage. One server replaces what typically takes a database, a file store, a scripting layer and a WebSocket service.

## Core principle: compute is cheap, transport is not

Every feature in DeepJSON follows from one assumption: **CPU time on the server
costs less than moving data to the client and back.** So manipulation belongs
next to the data, and a response should carry the answer rather than the material
needed to work it out.

The difference is not marginal. Attaching four fields of metadata to a stored
scanner document, the conventional way, means fetching the document, changing it
locally and sending it back — for a 222 MB document that is roughly 444 MB over
the wire and two round trips. The same operation as a server-side script is about
150 bytes up and an acknowledgement down:

```javascript
await dj.put('scanner.bundle.' + hash, meta, `
  if (!custom) custom = {};
  custom.scanner = body;
  response = { ok: true };
`);
```

The document never leaves the server. The script runs where the data already is,
and `response` controls what comes back — so the client receives the result, not
the document.

This is why the server looks the way it does:

| Feature | What it avoids transporting |
|---------|-----------------------------|
| Server-side scripting | The document, in both directions, for every read-modify-write |
| `response` separate from `data` | The whole stored value when the client only needs an answer |
| `abort` and conditional requests | A round trip to discover the write should not happen |
| On-the-fly image transformation | The full-resolution original, when a 400px thumbnail was wanted |
| Real-time channels | Repeated polling for data that has not changed |
| Wildcard key generation | A round trip to ask which identifier is free |

The practical consequence for anyone building on it: if you find yourself reading
a document in order to decide something and then writing it back, that logic
belongs in a script. One round trip, no payload, and the operation is serialized
against other writers for free.

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

This is the mechanism behind [the core principle](#core-principle-compute-is-cheap-transport-is-not): the script runs where the data already sits, so a read-modify-write costs one round trip and moves no document.

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

Only the values a script actually mentions are sent into the sandbox. The context crosses the
boundary as a single JSON string, and `origin` is the whole stored record while `data` is its
value — so a script that touches neither never pays for the document. Anything withheld is
restored afterwards, so a value a script does not mention survives the write untouched, exactly
as if it had been passed in.

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
| `abort` | Set this to refuse the operation: nothing is written and the request fails. `true` gives 412, a string becomes the message, `{ status, error }` sets both (status clamped to 400-599) |
| `custom` | Persistent custom metadata on the record |

Refusing an operation uses `abort`, which is also how arbitrary preconditions are
expressed — any boolean logic over `data`, `custom`, `body` or `user`, with no
separate query syntax to learn:

```javascript
// reject unless the document is still a draft
await dj.put('reports.q3', { revenue: 50000 }, `
  if (data.status !== 'draft') {
    abort = { status: 409, error: 'only drafts may be edited' };
  } else {
    data = { ...data, revenue: body.revenue, status: 'review' };
  }
`);
```

Without `abort` a script cannot decline a write. Setting an error on `response`
alone still returns the document to be stored, so the write happens anyway, the
document's `_modCounter` advances and the request reports success.

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

### Querying

DeepJSON has no value-based query engine. There are two patterns instead, and
between them they cover most access patterns without one — but it is worth knowing
the limit before you design around it.

**1. The key hierarchy is the index.** Keys are dotted paths, and the whole
keyspace lives in memory, so a pattern over key *names* is answered without
reading a single document:

```javascript
// every scanner bundle for one client site
const { keys, total } = await dj.listKeys('^de\\.zeitgeist\\.wiesbaden\\.scanner\\.bundle\\.');

// just the count, no keys transferred
const { total } = await dj.listKeys('^de\\.zeitgeist\\.', { count: true });

// one page at a time
const page = await dj.listKeys('^de\\.', { limit: 100, offset: 200 });
```

| Option | Meaning |
|--------|---------|
| `keys` | Regular expression matched against the key name |
| `limit`, `offset` | Page through the result. `total` always reports the full match |
| `count` | Return only `total`, with no key list |

So encode in the key what you will want to search by — client, site, type, date —
and lookups stay index-only. `GET /cmd/keys/` and `GET /admin/keys` both work this
way, and `key_list_limit` in `dj.config` lets an operator cap any single listing.

**2. Model a collection as one document.** When a set of records is read and
written together, store them under one key and query inside a script. The whole
operation is one round trip, and it is serialized against other writers for free:

```javascript
// reserve a block of ids from a client record, server-side
const result = await dj.put('clients', { kNumber: 'K-17', count: 20 }, `
  var client = data.find(function (c) { return c.kNumber === body.kNumber; });
  if (!client) { abort = { status: 404, error: 'unknown client' }; }
  else {
    var start = client.docIdCounter || 1;
    client.docIdCounter = start + body.count;
    response = { start: start, end: start + body.count - 1 };
  }
`);
```

Nothing but the request and `{ start, end }` crosses the network. This is the
[core principle](#core-principle-compute-is-cheap-transport-is-not) applied to
reads as much as writes.

**What this does not do.** There is no index on document contents, so "every
document where `status = 'pending'`" means reading every candidate document. A
script cannot help: it receives its own document and nothing else, by design. If
an access pattern needs selectivity on a field, the options today are to encode
that field in the key, or to keep the collection in one document and search it
inside a script.

### Conditional Requests

Every response for a key carries an `ETag` — the document's version. Send it back
as `If-Match` on a write and the server refuses if the document has moved on.

```http
GET /keys/acct.1
200 OK
ETag: "2"

PUT /keys/acct.1
If-Match: "2"
200 OK
ETag: "3"          ← chain this into the next write, no re-read needed

PUT /keys/acct.1
If-Match: "2"      ← stale: someone else already wrote "3"
412 Precondition Failed
ETag: "3"
{ "error": "Precondition failed: ...", "expected": "\"2\"", "current": "\"3\"" }
```

This closes a gap that per-key locking cannot. A write is serialized against other
writes to the same key, so a script-driven read-modify-write inside one request is
already safe. But a *client* that reads a document, decides something, and writes
in a second request can be overtaken in between — and without `If-Match` its write
wins silently, discarding whatever happened in the gap. With it, the second writer
gets a 412 and can retry against the current state.

| Header | Meaning |
|--------|---------|
| `If-Match: "3"` | Write only if the document is still at that version |
| `If-Match: "2", "3"` | Write if it is at either (a list is an OR) |
| `If-Match: *` | Write only if the key exists |
| `If-None-Match: *` | Create only if the key does **not** exist |

`If-Match` takes precedence over `If-None-Match`, per RFC 9110. Both work on `PUT`,
`POST` and `DELETE` — a conditional delete removes a document only if nobody has
touched it since you looked.

Notes:

- **Entirely opt-in.** A request without these headers behaves exactly as before,
  so existing clients need no changes.
- The 412 response carries the **current** `ETag`, so a client that loses a race
  can retry straight away instead of issuing another `GET` first.
- The tag comes from the document's own `_modCounter`, not the server-global
  modification counter. That matters after a restore: `rebuild-index` renumbers the
  global counter, while the per-document value is stored inside the document and
  survives.
- Input is read leniently — unquoted tags and a `W/` prefix are accepted, since
  clients get those wrong often enough that refusing is unhelpful. What the server
  emits is always a correctly quoted tag.

### Durability

Every document is written to a temporary file and moved into place with `rename()`,
which is atomic on POSIX — a reader always sees either the whole previous document
or the whole new one, never half of one. Whether that write has reached the disk
before the client is told it succeeded is controlled by `durability`.

| Mode | Behaviour | Cost per write |
|------|-----------|----------------|
| `"sync"` *(default)* | The document, its directory entry and the index log are flushed before the response is sent | ~3 ms |
| `"async"` | The write is acknowledged once the kernel has it; the OS flushes when it chooses | ~0.1 ms |

Measured serially on an SSD volume, three flushes per write. Writes to different
keys flush concurrently, so that figure is a floor rather than a throughput
ceiling; the index flush in particular is taken outside the index lock so writes
do not queue behind each other's flushes.

Worth knowing what `"async"` actually risks: nothing is lost on a normal restart,
a deployment or `systemctl restart`, because an orderly shutdown flushes the page
cache. The exposure is a power cut, a kernel panic or a hard reset of the VM — and
then the last seconds of *confirmed* writes are gone, with nothing in the logs to
say so.

**When to use which:**

```json
// Default. Anything a client is told succeeded and will not send again:
// orders, payments, user accounts, scanned documents, audit records.
// Required if you rely on single-key operations being transactional.
{ "durability": "sync" }
```

```json
// Data you could regenerate from a source of truth: caches, search or
// lookup indexes, telemetry, pre-rendered thumbnails. Also useful for a
// one-off bulk import, switched back to "sync" afterwards.
{ "durability": "async" }
```

The rule of thumb: if losing the last few seconds of writes after a power cut
would mean someone re-enters data by hand, or a customer is told something
happened that did not, stay on `"sync"`. The ~3 ms is cheaper than the
conversation.

Starting with `"async"` prints a warning at startup, so the choice is visible to
whoever next reads the logs rather than buried in a config file.

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
| `key_list_limit` | number | Maximum keys returned by a single listing. Omit for unlimited |
| `durability` | string | `"sync"` (default) flushes each write to disk before acknowledging it; `"async"` acknowledges first and lets the OS flush. See [Durability](#durability) |
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

**Vertical scaling**: the content-addressable storage distributes files across a configurable directory tree (controlled by `index_depth`). A depth of 3 creates up to 16 million leaf directories, avoiding filesystem bottlenecks even with millions of keys. The in-memory index provides O(1) key lookups regardless of dataset size. The index is fully resident, so size your memory against key count, and startup replays the index log — run `POST /admin/rotate-index` or set `index_archiving.rotate_every_hours` to keep that log compact.

### Horizontal scaling: key-based sharding

Supported today, and it needs no changes to the server — only proxy configuration.

nginx computes the SHA-256 of the key in Lua and routes each request to the instance that owns that key's hash range. Every instance has its own `data_root` and its own index, and is the sole reader and writer for its keys. Nothing is shared, so nothing needs coordinating: per-key write serialization, index consistency and index rotation are each already correct within a shard. Clients talk to one endpoint and need no awareness of the split.

```
                    ┌──────────────┐
                    │  nginx + Lua │  sha256(key) → shard
                    └──────┬───────┘
                 ┌─────────┼─────────┐
                 ▼         ▼         ▼
            DeepJSON   DeepJSON   DeepJSON
            data_root  data_root  data_root
```

Requirements:

- **Map fixed hash buckets to instances**, not `hash % instance_count`. With buckets, adding an instance relocates one bucket's keys; with modulo, nearly the whole keyspace moves.
- **Key listings are per-shard.** `GET /cmd/keys/` and `GET /admin/keys` return the keys of the instance that answered. Fan out client-side if you need a complete listing.
- **`POST /cmd/move` is shard-local.** Its keys travel in the request body, so the proxy cannot route it by key. Moves whose source and target fall in different shards need a coordinator.
- **`*{type:inc}` is per-shard.** The next sequence number is taken from the serving instance's index, so two shards can issue the same number. Use `*{type:random}`, or route one key family to a single shard. `*{type:random}` is unaffected.
- **`/admin/modifications/:since`** counts per shard; poll each instance.

### Horizontal scaling: shared storage (coming soon)

Coming soon, and the next topology on the roadmap: several instances over one filesystem (NAS, NFS, EFS or any POSIX mount), with storage left unified so no resharding is ever needed.

It works by not trusting the in-memory index rather than by synchronising it. Because storage is content-addressable, a key's path is computed from its name — reads already resolve straight from disk and never consult the index. A `stateless` mode therefore resolves key existence from the filesystem too, which is what makes several instances over one mount coherent, and demotes the index to a local cache.

Two pieces are required and not yet implemented:

- **`stateless` mode**, resolving existence from disk. Existence is established by attempting the read rather than by `stat()`, so NFS attribute caching cannot produce a false miss: close-to-open consistency covers `open()`, and the handler was going to read the document anyway.
- **Optimistic concurrency on `_modCounter`**, the per-document counter that already exists and increments on every write. Without it two instances can read the same document, run their scripts and both write, losing one update — a disk-backed existence check prevents stale 404s but serializes nothing.

Known limits of this topology: key listings stay index-backed and may be stale, `*{type:inc}` needs a counter key or a pinned instance, and index rotation is refused, since it would rewrite the log from one instance's non-authoritative view.

### Real-time channels

WebSocket sessions are held per instance in memory. Sticky sessions (session affinity) at the load balancer ensure every participant in a channel reaches the same instance — the pattern Socket.IO uses in clustered environments. This applies to both topologies above.

| Scaling strategy | How |
|-----------------|-----|
| More users / higher throughput | Shard by key at the proxy |
| Larger datasets | Increase `index_depth`, or add shards |
| Bigger files / more storage | Expand or mount larger volumes at `data_root` |
| Unified storage across instances | Shared storage with `stateless` mode (coming soon) |
| Real-time at scale | Sticky sessions per channel |

## Backup and restore

Backups run against a live server. No downtime, no quiescing, and no snapshot
support required from the filesystem.

That works because of how documents are written: each one goes to a temporary file
and is moved into place with `rename()`, so every file a copy picks up is a
complete, valid document even if it was copied while that key was being written.

### What to back up

| Path | Needed? | Why |
|------|---------|-----|
| `<data_root>/data/` | **Yes** | The documents. The only data that cannot be reconstructed |
| `/etc/deepjson/access.json` | **Yes** | Users, groups, password hashes. Lives outside `data_root` |
| `/etc/deepjson/dj.config` | **Yes** | Server configuration. Also outside `data_root` |
| `<data_root>/index/` | No | Rebuilt from the documents, see below |
| `<data_root>/logs/` | Optional | Request history, not state |

The two config files are the easy thing to miss: they are not under `data_root`, and
a backup without `access.json` restores every document but no way to log in.

```bash
# Nightly, against a running server
rsync -a --delete /var/lib/deepjson/data/ backup@store:/backups/deepjson/data/
rsync -a /etc/deepjson/ backup@store:/backups/deepjson/etc/
```

### Restoring

```bash
# 1. Put the files back
rsync -a backup@store:/backups/deepjson/data/ /var/lib/deepjson/data/
rsync -a backup@store:/backups/deepjson/etc/  /etc/deepjson/

# 2. Start the server. It comes up with an empty index and reports no keys.
systemctl start deepjson

# 3. Rebuild the index from the documents on disk
curl -X POST https://your-host/admin/rebuild-index -H "Authorization: Bearer $TOKEN"
```

Step 3 is what makes the index disposable: `rebuild-index` walks the data tree and
reconstructs every entry from the documents themselves, which carry their own
`_key`, `_hash`, `_created`, `_modification` and `_modCounter`. Until it runs, keys
are present on disk but absent from the index, so reads return 404.

To rehearse a restore without touching production, point a second `dj.config` at a
copy of the data with a different `port` and `data_root`, start it, rebuild, and
compare `GET /cmd/keys/`.

### Two things to know

**A live copy has no cross-key consistency.** Each *file* is valid, but a copy can
catch key A before a write and key B after it, so a change spanning two keys may be
captured half-done. `POST /cmd/move` is read-write-delete, so a copy taken mid-move
can hold both copies of a document or neither. If you need a consistent
point-in-time image across keys, take a filesystem or volume snapshot (LVM, ZFS,
btrfs, EBS) and copy from that instead.

**A rebuild renumbers the modification counter.** The index's global counter is
derived from each document's own `_modCounter` during a rebuild, so the values
`/admin/modifications/:since` reports after a restore do not continue the old
sequence. Clients polling that endpoint must reset their cursor rather than resume
from the number they last saw.

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
| Horizontal scaling | Sharded | Managed | Sharding | Cluster | Managed |

## License

[Prosperity Public License 3.0.0](LICENSE). Free for non-commercial use. Commercial use is permitted for a 30-day trial period. See [LICENSE](LICENSE) for full terms.

## Contributing

Contributions are welcome. Please open an issue or pull request on [GitHub](https://github.com/hayde/deepjson).
