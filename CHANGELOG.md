# Changelog

All notable changes to the DeepJSON server. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Client connectors are versioned separately and move faster than the server; where a
change affects what a client sees on the wire, it says so.

## [Unreleased]

### Security

- **A key name could forge entries in the index log.** Keys were written into
  `dj.index` unescaped, so a key holding a line break or `|` could plant a fake
  line, for example a `DELETE` of another user's key that took effect at the next
  restart. Index lines are now written so no key can break them: ordinary keys keep
  the existing `key|hash|...` form, and a line that a key could break (a key
  containing `|`, a line break or invalid Unicode, or starting with `{`, or a user id
  containing a line break) is written as one JSON line. Keys with `|` written from
  now on survive a restart under their exact name, which they did not before. Creating a key whose
  name contains control characters or invalid Unicode is refused with `400`;
  existing keys stay reachable. `/cmd/move` returns `400` for a non-string `from` or
  `to`.
- **A placeholder password hash accepted any password (#26).** A stored hash that
  decoded to zero bytes, such as `scrypt:REPLACE:REPLACE` in
  `examples/access.json.example`, matched every password, so a copied example file
  gave anyone a superadmin login; a very short hash could be guessed in a few hundred
  tries. A password now verifies only against a well-formed hash
  (`scrypt:<salt>:<128 hex characters>`), and the server refuses to start, or to
  reload `access.json`, while any user has a malformed one. `"password": null`
  disables password login for an account used only through device authentication.
  Login also no longer treats built-in names such as `__proto__` as users.

### Upgrade notes

- **A server whose `access.json` holds a placeholder or malformed password hash will
  not start** after this upgrade; the error names the user. This includes a hash
  with a stray space or line break, which used to work. Check before upgrading:
  `node -e 'const a=require(require("path").resolve(process.argv[1]));for(const[u,x]of Object.entries(a.users||{}))if(typeof x.password==="string"&&!/^scrypt:[0-9a-fA-F]{16,128}:[0-9a-fA-F]{128}$/.test(x.password))console.log("fix:",u)' /etc/deepjson/access.json`.
  Give each listed user a real hash (`node bin/hash-password.js <password>`), or
  `"password": null` if it should not log in with a password.
- **If a server ran with a placeholder or malformed hash while reachable**, treat it
  as compromised: anyone could have logged in as that user, and a token obtained that
  way keeps renewing itself after this fix. Change `jwt_secret` in `dj.config` and
  restart, which invalidates every issued token, then review the data and
  `access.json` for changes.
- **If the server was reachable by untrusted users before this release**, `dj.index`
  may hold forged lines, including some that only take effect on this version. Before
  the first start, check `grep -n '^{"v":2,' index/dj.index`: an index written by an
  earlier version must not contain such lines. If it does, or to be safe, run
  `POST /admin/rebuild-index` followed by `POST /admin/rotate-index` after starting.
  Data files are never affected.
- **Keys containing `|` written by an earlier version** are in the index under a
  truncated name. The same rebuild followed by rotate restores their exact names.
- **Rolling back** to an earlier version keeps working for ordinary keys. Keys
  containing `|`, a line break, or starting with `{` would be misread again, and the
  original issue returns with the old version.

## [1.1.0] - 2026-10-13

The first release since the initial commit, so it covers a lot. Two items need
attention before upgrading — see **Upgrade notes** at the end.

### Added

- **`GET /version`** and **`GET /whoami`**, both behind authentication, so each doubles
  as a connectivity check and carries a renewed token. `/whoami?keys=a,b` resolves the
  effective CRUDX permissions for named keys through the same code that enforces them.
- **Conditional requests.** Every key response carries an `ETag` derived from the
  document's own `_modCounter`. `If-Match` on a write refuses with `412` when the
  document has moved on, which closes the lost-update gap that per-key locking cannot:
  a client that reads, decides, and writes in a second request can otherwise be
  overtaken in between. `If-None-Match: *` is a conditional create; on a read a match
  returns `304 Not Modified`. The `412` response carries the current `ETag`, so a
  client that loses a race can retry without re-reading.
- **`durability`** in `dj.config`, `"sync"` (default) or `"async"`. In sync mode the
  document, its directory entry and the index log are flushed before the response is
  sent. Measured at about 3 ms per write on an SSD volume against 0.1 ms unflushed.
- **Index compaction**, reachable via `POST /admin/rotate-index` or on a schedule with
  `index_archiving.rotate_every_hours`. Archive retention (`older_than_days`) now
  actually runs, since it only ever executed as part of a rotation.
- **`POST /admin/reload-access`**, so adding a user or changing a permission no longer
  needs a restart. All-or-nothing: the new file must parse and validate before it
  replaces anything, and a broken file leaves the running server exactly as it was.
- **`abort` in server-side scripts.** Setting it refuses the operation: `true` gives
  `412`, a string becomes the message, `{ status, error }` sets both. Doubles as the
  precondition mechanism — arbitrary boolean logic over `data`, `custom`, `body` and
  `user`, with no separate query syntax.
- **Key listing options**: `limit`, `offset` and `count` on `/cmd/keys/` and
  `/admin/keys`, with a `key_list_limit` ceiling in `dj.config`. Responses now include
  `total`, reporting the full match regardless of the page returned.
- **Per-group CORS whitelist** via `allowed_origins` in `access.json`, covering both the
  Express middleware and socket.io.
- **Sliding sessions**: every authenticated response carries a renewed JWT in
  `X-Renewed-Token`, so an active client never expires.
- **Configurable text body limit** (`text_payload_limit`) and **per-key payload limits**
  (`key_payload_limits`), the latter now also governing multipart file uploads.
- **Startup validation** of `dj.config` and `access.json`, collecting every problem and
  reporting them together rather than failing on the first.
- **A startup warning for cross-group permission revocation**, naming the user, the
  affected operations and an example key. Groups are walked in the order a user lists
  them and the last matching rule wins, so adding a group can silently revoke access.
  Within-group overrides are a documented idiom and are not reported.

### Changed

- **`durability` defaults to `"sync"`**, so writes are flushed before being
  acknowledged. Previously nothing was ever flushed and a power loss could lose a
  confirmed write. Set `"async"` to restore the old behaviour; it prints a warning at
  startup.
- **Writes are serialized per key** and documents are written atomically, via a
  temporary file and `rename()`.
- **Scripts receive only the context values they reference.** `origin` and `data` are
  withheld from a script that never mentions them, and restored afterwards so callers
  see no difference. On a 100 MB document the context dropped from 200 MB to 100 MB for
  an unchanged script, and to under 1 KB once a redundant `data = data;` is removed.
- **Key listing filters by name before checking permissions**, which is the expensive
  half. On an index of 11,691 keys with five rules, a prefix query went from 220 ms to
  88 ms with identical results.
- **`X-Powered-By` is no longer sent.**
- A malformed `keys` pattern or a negative `limit` on a listing is now a `400` naming
  the problem, rather than an unhandled error.

### Fixed

- **Concurrent writes could corrupt documents and lose acknowledged updates.** Measured
  before: three workers doing 40 writes each on one key, 8 acknowledged, none
  surviving. After: 120 of 120 survive.
- **A rejected script still wrote the document.** The sandbox always returns `data`, so
  a script that set only an error on `response` still handed back a storable record,
  the write proceeded, `_modCounter` advanced and the request reported `200`. Use
  `abort` to decline.
- **Replacing a file reset the document.** The upload path passed a placeholder string
  where a record was expected, so every upload took the "new record" branch: the
  version returned to 0, `_created` was reset and `custom` was discarded. With ETags
  derived from the version, this also meant a browser could serve a replaced file from
  cache indefinitely.
- **A matching `If-None-Match` returned `412` on a read**, so a browser revalidating a
  cached image or PDF received an error body in place of the document — and only on the
  second view, which made it look intermittent. RFC 9110 requires `304 Not Modified` on
  GET and HEAD; `412` is now returned only for other methods.
- **A rotation could lose a concurrent index append**, and the rewritten log had no
  trailing newline, so the next append was glued onto the last line and the appended
  key disappeared on the next startup.
- **A token naming a deleted user was accepted** and failed later inside the permission
  check as a `500`. It is now a `401`.
- **`express.text()` silently fell back to body-parser's 100 kb default**, capping the
  main key-write path far below `payload_limit`.
- **`saveIndexSnapshot()` omitted `modCount`**, so an archive snapshot could not stand
  in for the live index.

### Security

- **Execute permission no longer confers administrative access.** `checkAdmin()`
  returned true for any group holding `X` on any rule, so a group scoped to a single key
  prefix with `crudx: "11111"` reached the whole `/admin/*` surface — including
  `/admin/logs`, which returns request history across every client — without being in an
  admin group. Admin is now group membership only, which is what the documentation
  already stated.

### Upgrade notes

- **Check who had admin by accident.** Any user in a group whose rules grant `X` held
  administrative access before this release and will lose it. Verify with
  `GET /whoami` for each user before upgrading, and move anyone who genuinely needs
  admin into an `admin` or `superadmin` group.
- **Writes are now flushed.** Expect roughly 3 ms per write on an SSD where there was
  previously none. If a write-heavy deployment measures a problem, `durability: "async"`
  restores the old behaviour, with the data-loss exposure that implies.
- **Stale file caches may persist briefly.** Because every previously uploaded file
  carried `ETag "0"` regardless of how often it was replaced, a browser holding that tag
  for a file replaced *before* this release will still be told `304`. It resolves the
  next time that file is replaced, or on a hard reload.

## [1.0.1] - 2026-09-09

- Initial commit.
