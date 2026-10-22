# DeepJSON Server Configuration

Reference for `dj.config`, the server's configuration file.

> **Document structure.** Every `##` is a section and every `###` is a single
> configuration key. A navigation sidebar can be generated from those two levels
> alone, with no other parsing required.

---

## Overview

### How the configuration is loaded

The server reads one JSON file, given as the first command line argument:

```bash
node main.js /etc/deepjson/dj.config
```

Without an argument it falls back to `/etc/deepjson/dj.config`. The `npm start`
script uses exactly that path.

The file is plain JSON. Comments are not permitted, because it is parsed with
`JSON.parse`.

Two files are involved in total. `dj.config` holds server settings and is
described here. It points at a second file through `access_file`, which holds
users, groups and permissions, and which is documented separately.

**Everything is read once, at startup.** Editing either file has no effect on a
running process. A restart is required, including after changing a password or
adding a user.

### Validation at startup

Before the server accepts any request it validates both files and **refuses to
start** if anything is wrong. Every problem is collected and reported together,
so a broken installation can be repaired in one pass rather than one restart per
mistake:

```
Invalid configuration (3 problems):
  - jwt_secret is required and must be a non-empty string
  - index_depth must be an integer between 1 and 32 (got 0)
  - script_engine "quickjs" is unknown. Valid options: "wasm" (omit the key to use "wasm")
```

Less severe findings are printed as warnings and do not prevent startup:

```
Config warning: jwt_secret is only 26 characters; use a long random value (32+)
```

You can validate a configuration without starting anything, which is worth doing
before deploying to a live server:

```bash
node -e "
const S = require('/path/to/deepjson/server');
const s = Object.create(S.prototype);
s.config = JSON.parse(require('fs').readFileSync('/etc/deepjson/dj.config','utf8'));
s.accessData = JSON.parse(require('fs').readFileSync(s.config.access_file,'utf8'));
try { s.validateConfig(); console.log('configuration OK'); }
catch (e) { console.log(e.message); }
"
```

### Quick reference

| Key | Type | Required | Default |
|---|---|---|---|
| [`data_root`](#data_root) | string | yes | none |
| [`access_file`](#access_file) | string | yes | none |
| [`port`](#port) | integer | yes, unless SSL is enabled | none |
| [`ssl`](#ssl) | object | no | disabled |
| [`jwt_secret`](#jwt_secret) | string | yes | none |
| [`index_depth`](#index_depth) | integer 1–32 | yes | none |
| [`index_archiving`](#index_archiving) | object | no | no retention |
| [`payload_limit`](#payload_limit) | size | no | `"10mb"` |
| [`text_payload_limit`](#text_payload_limit) | size | no | `payload_limit` |
| [`key_payload_limits`](#key_payload_limits) | array | no | none |
| [`script_engine`](#script_engine) | string | no | `"wasm"` |
| [`script_execution_time_limit`](#script_execution_time_limit) | integer ms | no | `5000` |
| [`emptySessionTTL`](#emptysessionttl) | integer ms | in practice yes | none, see below |
| [`maxClientsPerSession`](#maxclientspersession) | integer | in practice yes | none, see below |
| [`allowMultipleSessionConnections`](#allowmultiplesessionconnections) | boolean | no | falsy |
| [`preventDuplicateSessionConnections`](#preventduplicatesessionconnections) | boolean | no | falsy |
| [`debug`](#debug) | boolean | no | falsy |

### Complete example

```json
{
  "data_root": "/var/lib/deepjson",
  "access_file": "/etc/deepjson/access.json",

  "port": 3000,
  "ssl": {
    "enabled": false,
    "port": 8443,
    "key": "/etc/ssl/private/deepjson.key",
    "cert": "/etc/ssl/certs/deepjson.crt"
  },

  "jwt_secret": "REPLACE_WITH_64_RANDOM_HEX_CHARACTERS",

  "index_depth": 3,
  "index_archiving": {
    "older_than_days": 30,
    "archiving_url": null
  },

  "payload_limit": "10mb",
  "text_payload_limit": "10mb",
  "key_payload_limits": [
    { "regex": "^uploads\\.bulk\\..*", "limit": "100mb" },
    { "regex": "^media\\..*",          "limit": "30mb"  },
    { "regex": "^.*",                  "limit": "10mb"  }
  ],

  "script_engine": "wasm",
  "script_execution_time_limit": 5000,

  "emptySessionTTL": 60000,
  "maxClientsPerSession": 10,
  "allowMultipleSessionConnections": true,
  "preventDuplicateSessionConnections": false,

  "debug": false
}
```

### Minimal example

Everything optional removed. This is the smallest configuration that starts:

```json
{
  "data_root": "/var/lib/deepjson",
  "access_file": "/etc/deepjson/access.json",
  "port": 3000,
  "jwt_secret": "0f3a...64 random hex characters...9c1b",
  "index_depth": 3
}
```

Note that omitting `emptySessionTTL` and `maxClientsPerSession` is *permitted*
but produces surprising behaviour if you use WebSocket sessions. See those two
keys.

---

## Paths

### data_root

| | |
|---|---|
| Type | string, absolute path |
| Required | yes |
| Default | none |

Base directory for everything the server stores. On startup it creates, if
missing:

```
<data_root>/
  data/            the documents themselves, nested by hash
  index/           dj.index, the live index log
  index/archive/   dated index snapshots
  logs/            one request log per day
  scripts/         reserved
```

The process needs read and write access to this directory. On a dedicated
service account, `0700` on `data/` is appropriate, since documents are stored
unencrypted.

### access_file

| | |
|---|---|
| Type | string, absolute path |
| Required | yes |
| Default | none |

Path to `access.json`, holding users, groups, permissions and device
credentials. It is validated at startup alongside `dj.config`: a user pointing at
a group that does not exist, a rule with a regex that does not compile, or a
password that is not a well-formed scrypt hash (`scrypt:<salt>:<128 hex
characters>`, as `node bin/hash-password.js <password>` produces) all prevent the
server from starting. Set `"password": null` for an account that only logs in
through device authentication; it then cannot log in with a password.

The file contains password hashes and device secrets, so it should be `0640` at
most, owned by the service account.

**Read at startup and on `POST /admin/reload-access`.** A reload is validated the
same way; a file with a problem is refused and the previous access data stays in
effect.

---

## Network

### port

| | |
|---|---|
| Type | integer, 1–65535 |
| Required | yes, unless `ssl.enabled` is true |
| Default | none |

TCP port for plain HTTP. Ignored entirely when SSL is enabled, in which case
`ssl.port` applies instead.

### ssl

| | |
|---|---|
| Type | object |
| Required | no |
| Default | disabled |

```json
"ssl": {
  "enabled": true,
  "port": 8443,
  "key": "/etc/ssl/private/deepjson.key",
  "cert": "/etc/ssl/certs/deepjson.crt"
}
```

When `enabled` is true, the server listens via HTTPS on `ssl.port`, and `key` and
`cert` must both point at files that exist. Startup validation checks this and
refuses to start otherwise, rather than failing at the first connection.

When a request arrives over a secure connection the server also sets
`Strict-Transport-Security: max-age=31536000`.

If you terminate TLS at a reverse proxy instead, leave this disabled and let the
proxy handle certificates.

---

## Authentication

### jwt_secret

| | |
|---|---|
| Type | string |
| Required | yes |
| Default | none |

Signing key for the JSON Web Tokens issued by `POST /auth/login`. Anyone who
knows it can mint valid tokens for any user, so it belongs in a file readable
only by the service account, and never in version control.

Generate one properly:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

A secret shorter than 32 characters produces a startup warning. Changing it
invalidates every token in circulation, forcing all clients to log in again,
which is also the mechanism for revoking tokens in an emergency.

**The token lifetime is one hour and is not configurable.** Each authenticated
response carries a refreshed token in the `X-Renewed-Token` header, so a client
that reads that header and uses it for the next request keeps a rolling session.
A client that ignores it is logged out one hour after login.

---

## Storage and index

### index_depth

| | |
|---|---|
| Type | integer, 1–32 |
| Required | yes |
| Default | none |

How many directory levels a document's path is split into. The key's SHA256 hex
digest supplies two characters per level, so `index_depth: 3` stores a document
whose digest begins `a211ff…` at:

```
<data_root>/data/a2/11/ff/a211ff…
```

The upper bound of 32 comes from the digest being 64 hex characters long.

> **This value cannot be changed once data exists.** The path is recomputed from
> the key on every read, so changing the depth makes the server look in
> directories that were never written. Existing documents become invisible: not
> readable, not deletable, and worse, not detected as existing, so a write to
> that key silently creates a second copy elsewhere. Migrating means rewriting
> every document.

Pick a depth that suits the expected number of documents. Two levels give 65,536
directories, three give 16.7 million. Three is a reasonable default.

### index_archiving

| | |
|---|---|
| Type | object |
| Required | no |
| Default | no retention, archives kept forever |

```json
"index_archiving": {
  "older_than_days": 30,
  "archiving_url": null
}
```

`older_than_days` deletes snapshots in `index/archive/` whose date, taken from
the `dj.index.YYYYMMDD` filename, is further in the past than the given number of
days. Omit the key, or the whole object, to keep everything.

`archiving_url` is **reserved and not implemented**. The intended behaviour is
that each archived snapshot would be sent to that URL, whose response decides
whether the file may be deleted, letting an external system own the retention
policy. Setting it today logs a warning and changes nothing.

> **Caveat worth knowing:** retention only runs as part of index rotation, and
> rotation currently has no HTTP endpoint and no scheduler. Configuring
> `older_than_days` therefore has no effect until rotation is triggered.

---

## Request size limits

Three keys, applying to different paths, resolved in a defined order.

### payload_limit

| | |
|---|---|
| Type | byte count, or size string such as `"10mb"` |
| Required | no |
| Default | `"10mb"` |

Maximum size of a JSON request body outside `/keys/:key`, meaning any request sent
with `Content-Type: application/json` to `POST /auth/login` or the `/cmd/*` routes.
A key written as `application/json` is a key write and gets the key's limit instead,
exactly like a `text/*` write (see `text_payload_limit` and `key_payload_limits`).

Accepted forms are a plain number of bytes, or a string with a unit: `b`, `kb`,
`mb`, `gb`, `tb`, `pb`. A value that is neither is rejected at startup.

### text_payload_limit

| | |
|---|---|
| Type | byte count, or size string |
| Required | no |
| Default | falls back to `payload_limit`, then `"10mb"` |

Maximum size of a `text/*` or `application/json` request body written to
`/keys/:key`. Since writing a key is the normal route, this is the limit users
actually meet.

Set it only when text writes should differ from everything else. It exists as a
separate key because the underlying parser otherwise falls back to a built-in
100kb default, far below `payload_limit`, which silently capped the main write
path.

### key_payload_limits

| | |
|---|---|
| Type | array of `{ regex, limit }` |
| Required | no |
| Default | none, the fallback above applies |

Per-key limits, for when one part of the key namespace legitimately carries much
larger documents than the rest.

```json
"key_payload_limits": [
  { "regex": "^uploads\\.bulk\\..*", "limit": "100mb" },
  { "regex": "^media\\..*",          "limit": "30mb"  },
  { "regex": "^.*",                  "limit": "10mb"  }
]
```

**The first matching entry wins.** Order from most specific to least, and put any
catch-all last. A catch-all placed earlier makes every later entry unreachable,
which startup validation warns about.

Note this is the opposite of how permission rules in `access.json` resolve, where
the *last* match wins. The two are deliberately different and it is worth
remembering which is which.

The list is optional, and so is a catch-all inside it. If the list is missing, if
nothing matches, or if the key does not exist yet, the ordinary fallback applies:
`text_payload_limit`, then `payload_limit`, then 10mb. A key is never left
without a limit.

Every regex must compile and every limit must be a valid size, both checked at
startup.

> **Upper bound.** A document is serialized to a single string before being
> written, and no string in Node may exceed 512 MB. Content needing heavy JSON
> escaping inflates during serialization, measured at roughly 1.6x for text dense
> with quotes, backslashes and newlines. A limit above 256mb therefore produces a
> startup warning, because whether a given upload succeeds starts to depend on
> its content. For genuinely large binaries, store the file separately and keep
> only a reference in the document.

---

## Scripting

### script_engine

| | |
|---|---|
| Type | string |
| Required | no |
| Default | `"wasm"` |
| Valid values | `"wasm"` |

Sandbox used to run `javascript:` payloads. `"wasm"` is QuickJS compiled to
WebAssembly, which ships no Node globals at all: `process`, `require`, `fs` and
`fetch` simply do not exist inside a script, so there is nothing to remember to
remove.

Any other value is rejected at startup. Note the value is `"wasm"`, the engine,
not `"quickjs"`, the library that implements it. That mix-up is easy to make and
used to let the server start and then fail on the first script that ran.

A V8-based engine was evaluated and deliberately not wired up.

### script_execution_time_limit

| | |
|---|---|
| Type | integer, milliseconds |
| Required | no |
| Default | `5000` |

Wall-clock budget for a single script. Exceeding it aborts the script and
returns `Script exceeded maximum execution time`. An endless loop is therefore
contained rather than blocking the server.

Since scripts on the same key are serialized, a long limit on a hot key delays
every writer queued behind it. Keep it as low as your slowest legitimate script
allows.

The memory ceiling of 50 MB per script is **not configurable**.

---

## WebSocket sessions

These four keys apply only to the socket.io channel feature.

> Read these carefully if you use sessions. Two of them have no default, and the
> resulting behaviour when they are absent is not what most people expect.

### emptySessionTTL

| | |
|---|---|
| Type | integer, milliseconds |
| Required | no, but see below |
| Default | **none** |

How long an empty channel is kept before being discarded, giving the last
participant a window to reconnect.

> **Omitting this is a trap.** The value is passed straight to `setTimeout`, and
> `setTimeout(fn, undefined)` fires almost immediately. An empty channel is then
> torn down at once rather than after a grace period. Set it explicitly whenever
> you use sessions. 60000, one minute, is a sensible starting point.

### maxClientsPerSession

| | |
|---|---|
| Type | integer |
| Required | no, but see below |
| Default | **none** |

Maximum number of simultaneous clients in one channel.

> **Omitting this disables the limit silently.** The check is
> `clients.length >= maxClientsPerSession`, and any comparison against `undefined`
> is false, so every join is permitted no matter how many are already connected.
> If you intend a limit, set it explicitly.

### allowMultipleSessionConnections

| | |
|---|---|
| Type | boolean |
| Required | no |
| Default | falsy, meaning not allowed |

Whether one user may hold several simultaneous connections to the same channel,
for instance from two browser tabs. Only consulted when
`preventDuplicateSessionConnections` is true.

### preventDuplicateSessionConnections

| | |
|---|---|
| Type | boolean |
| Required | no |
| Default | falsy, meaning no check |

Enables the duplicate-connection check at all. When false, the server never looks
at whether a user is already present, and `allowMultipleSessionConnections` has
no effect.

The two together:

| `preventDuplicate…` | `allowMultiple…` | Result |
|---|---|---|
| `false` | anything | No check, duplicates always allowed |
| `true` | `true` | Checked, duplicates allowed |
| `true` | `false` | Duplicates rejected |

---

## Diagnostics

### debug

| | |
|---|---|
| Type | boolean |
| Required | no |
| Default | falsy |

When true, error responses include the server-side stack trace in a `stack`
field.

**Leave this off in production.** Stack traces reveal absolute filesystem paths,
internal function names and library versions, all of which help an attacker.
Enable it temporarily when diagnosing a problem, and turn it back off.

---

## Not configurable

Worth knowing, because each is occasionally mistaken for a setting:

| Behaviour | Fixed value |
|---|---|
| Token lifetime | 1 hour |
| File upload size (`multipart/form-data`) | 50 MB |
| Script memory ceiling | 50 MB |
| Live index filename | `index/dj.index` |
| Archive snapshot filename | `index/archive/dj.index.YYYYMMDD` |

---

## Best practices

### Before going live

Work through this once per installation:

1. **Generate a real `jwt_secret`.** 32 random bytes as hex. Never reuse one
   between environments, or a token from staging is valid in production.
2. **Decide `index_depth` deliberately.** It cannot be changed afterwards without
   rewriting every document.
3. **Set `debug` to false.**
4. **Set `emptySessionTTL` and `maxClientsPerSession` explicitly** if you use
   WebSocket sessions, since their absent behaviour is not a sensible default.
5. **Restrict file permissions.** `0600` on `dj.config`, at most `0640` on
   `access.json`, `0700` on `data/`.
6. **Run the validation snippet** from the first section against the real files
   before restarting a live server. Validation refuses to start on a bad
   configuration, which is correct behaviour but turns a deploy into an outage if
   you find out the hard way.

### Sizing the limits

Start from the largest document you legitimately expect and add headroom, rather
than setting a generous limit everywhere. Each in-flight request holds its body
in memory, so the effective ceiling is your limit multiplied by the number of
concurrent uploads, and Node's default heap is around 2 GB.

Where one part of the namespace genuinely needs more, use
[`key_payload_limits`](#key_payload_limits) rather than raising the global
limit.

### Changing configuration safely

Everything is read at startup, so every change needs a restart. The safe
sequence:

1. Edit a copy, not the live file.
2. Run the validation snippet against the copy.
3. Move it into place and restart.
4. Confirm with `GET /version`, which requires authentication and therefore
   proves the server is up, reachable and accepting logins in one call.

### The setup script

`scripts/setup.sh` generates a working starting configuration: a random
`jwt_secret`, top-level session settings, and a sample device that stays disabled
until you enable it. It does not set every option; use the complete example in
this document for the rest.
