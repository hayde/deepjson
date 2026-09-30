# TODO

Open items found while working through the bug list and testing against a locally
running server. Ordered by how much they hurt, not by effort.

Every entry names where it lives and why it matters. Everything here is verified,
either reproduced against a running server or traced in the code, none of it is
guesswork.

---

## Data loss

### 0. Concurrent writes corrupt documents and lose acknowledged updates — FIXED

Fixed by writing atomically (temp file plus `rename`) and serializing modifying
requests per key through `withKeyLock()`. Verified with the original reproduction:
120 of 120 writes succeed where 8 did before, and no acknowledged update is lost.
A heavier run of 6 workers doing 50 writes each also comes out exact at 300 of 300.
Covered by `test/concurrency.test.js`.

The original analysis is kept below, because the reasoning still applies to any
future change in this area.

---

Reported by a client, reproduced here. `writeKeyData()`
([server.js:1605](server.js#L1605)) calls `fsp.writeFile()` directly, which
truncates the file in place and rewrites it, and there is **no locking anywhere in
the codebase**. Two consequences, both measured:

**Torn reads and permanent corruption.** A reader hitting the file mid-write gets
a partial document and `JSON.parse` fails. Worse, a shorter write landing on top
of a longer one leaves the tail of the old content behind. Measured on a probe
key: 696 bytes on disk, valid JSON ending at 678, 18 bytes of leftover garbage.
The document is then permanently unreadable, and it cannot even be deleted through
the API, because the route reads the key before reaching the delete
([server.js:984](server.js#L984)). Removing the file by hand is the only way out.

**Lost updates.** Read, run script, write is not serialized per key, so concurrent
writers overwrite each other's results. Three workers doing 40 writes each: 8
reported success, 0 survived in the document.

This is not a corner case for background jobs. The keys with by far the most
writes in the production index are exactly the shared lookup tables that multiple
people edit at once: `de.moegeldorfer.nuernberg.lookuptable` with 5584 index
entries and `de.zeitgeist.wiesbaden.lookuptable` with 3471.

Fixes, in increasing order of what they solve:

1. **Write atomically**: write to a temporary file in the same directory, then
   `fsp.rename()`, which is atomic on POSIX. A reader then sees either the old or
   the new document, never half of one. The temp file must sit on the same
   filesystem or the rename degrades to a copy. This removes the 500s and the
   corruption but not the lost updates.
2. **Serialize per key**: a promise chain per key around read-script-write. This
   removes the lost updates too. Note it only holds within one process; running
   several server instances would need file locking instead.
3. **Or optimistic concurrency** on `_modCounter`, which already exists per
   document and is incremented on every write. Note this is the field in the data
   file, not `modCount` in the index, which is a global counter. This pushes retry
   handling onto clients and would be a breaking change for existing ones.

### 0b. The index grows without bound

`updateIndex()` appends a line per operation ([server.js:1338](server.js#L1338))
and nothing ever compacts it, because `performIndexRotation()` is unreachable, see
item 10. In the production backup this is 33140 log lines for 6671 distinct keys,
a factor of five, with a single lookup table accounting for 5584 of them. Harmless
for correctness, since the replay is order-dependent and ends at the right state,
but it grows forever and slows every startup.

---

## Silent failures

Bugs that never raise their voice, which is why they survive so long.

### 1. Writing a key with `application/json` crashes

`parseScriptPayload()` ([server.js:1109](server.js#L1109)) expects a string and calls
`.indexOf()` on it. With `Content-Type: application/json`, `express.json()` has
already turned the body into an object, so it fails with
`body.indexOf is not a function`. The identical request with `text/plain` works.

The one content type you would try first against a JSON server is the only one
that doesn't work.

**The fix already exists in this project.** `parseMoveBody()`
([server.js:2223](server.js#L2223)) handles exactly this case, checking
`_.isObject(req.body)` before treating the body as text. `parseScriptPayload()`
is missing that check.

### 2. `custom` is lost when a script creates the key

`writeKeyData()` ([server.js:1605](server.js#L1605)) builds a fresh record for a key
that does not exist yet, carrying over only `_key`, `_hash`, `_created`,
`_modification`, `_modCounter` and `value`, and discarding everything else,
`custom` included. On an existing key it keeps the incoming record whole, so
`custom` survives there.

That asymmetry is what makes it hard to spot: it works the second time you try.

Verified against the raw file on disk, covered by `bin/test-scripting.js` where it
is flagged as a known defect.

### 3. A script does not know its own key while creating it

`processScriptBody()` ([server.js:883](server.js#L883)) fills `key` from `data._key`
and `hash` from `data._hash`. On a new key `data` is undefined, so both are
`undefined`, even though the key name is right there in the URL and the hash is
derivable from it.

A script that wants to write its own key name into the value cannot do so today.

### 4. Permissions depend on the order rules happen to be listed in

`checkPermissions()` ([server.js:793](server.js#L793)) assigns rather than
accumulates: `allowed = crudx[idx] === '1'`. It walks every group of the user and
every rule of those groups, and the **last** match wins. A later rule with a `0`
revokes what an earlier one granted.

Consequences:

- The same set of rules in a different order produces a different answer.
  Verified: `[allow .*, deny ^secret.]` denies `secret.foo`, while
  `[deny ^secret., allow .*]` allows it.
- Reordering a user's `groups` array in `access.json` silently changes their
  effective permissions, which is almost certainly not intended.
- Anyone reimplementing the check client-side will write "any matching rule
  grants it" and disagree with the server exactly where it matters. This is why
  `/whoami` marks its rules as advisory.

Decide whether last-match-wins is the intended semantic. If it is, document it
loudly. If it is not, the likely intent is "deny wins" or "first match wins",
and either is a behavioural change that needs care.

### 5. `deepjson-server-setup.sh` generates a broken configuration

Four faults, all silent, all in the generated result rather than the script run:

- **`hmac_øauth_settings`** ([line 54](deepjson-server-setup.sh#L54)) contains a `ø`.
  The code reads `hmac_auth_settings`, so `device_auth_enabled: true` is never
  seen and HMAC device authentication is off while the config claims otherwise.
- **`socketServer` nesting** ([line 29](deepjson-server-setup.sh#L29)): the code reads
  `preventDuplicateSessionConnections`, `allowMultipleSessionConnections` and
  `maxClientsPerSession` at the top level. Nested, they do nothing:
  `clients.length >= undefined` is always false, so the per-session client limit
  never applies.
- **Seeded `dj.index` with `#` comments** ([line 87](deepjson-server-setup.sh#L87)):
  `loadIndex()` knows nothing about comment lines and turns them into two real
  index entries keyed `"# Initial DeepJSON index file"` and `"# Format: key"`.
  The file should simply be empty.
- **`emptySessionTTL` is never set.** A `setTimeout` with `undefined` fires almost
  immediately, so empty sessions would be reaped at once.

Also: **`valid_until`** on the device ([line 50](deepjson-server-setup.sh#L50)) is
never evaluated anywhere. The field implies an expiry date that does not exist.

---

## Hardening

### 6. Startup validation should flag unknown config keys

`validateConfig()` checks known keys for sensible values but says nothing when a
key is misspelled or sitting at the wrong nesting level. A warning on unknown
top-level keys would have surfaced both `socketServer` and `hmac_øauth_settings`
from item 5 immediately.

### 7. Pattern support for the CORS whitelist

`isOriginAllowed()` ([server.js:348](server.js#L348)) compares exact strings.
Patterns like `http://localhost:*` for any port, or `https://*.example.com` for
subdomains, would be practical.

Critical detail, otherwise the whitelist becomes decoration: overly broad patterns
must be rejected at startup. `https://*` would admit the entire web, and `*` on its
own matches only `null`, because every real origin contains slashes. Allow exactly
two shapes: a port wildcard directly after a colon, and a subdomain wildcard
directly before a dot with at least two labels following.

### 8. No central error handling

There is no Express error middleware. As a result a rejected CORS origin returns
`500` instead of `403`, and an oversized body returns an HTML error page with a
stack trace instead of JSON, which clients expecting JSON then fail to parse.

### 9. The file upload limit is hardcoded

50 MB in `express-fileupload` ([server.js:314](server.js#L314)). `payload_limit` and
`text_payload_limit` are configurable, this one is not.

---

## Missing functionality

### 10. `performIndexRotation()` is unreachable

The method ([server.js:1449](server.js#L1449)) exists, complete with archiving and a
retention window, but no route and no scheduler ever calls it. Rotation can only
be triggered by a script today. Either add an admin route, or document explicitly
that an external cron is meant to drive it.

### 11. `archiving_url` is documented but not implemented

`cleanupIndexArchive()` ([server.js:1227](server.js#L1227)) describes the intended
contract and only logs a warning when the URL is set. Either implement it or drop
the option.

---

## Client side

### 12. The sliding session does not reach direct image URLs

An `<img src="...">` cannot read response headers, so it never sees
`X-Renewed-Token`. A token embedded in an image URL is frozen at the moment the
page rendered, and after an hour the images on a long-lived page stop loading even
though the user is still signed in elsewhere.

### 13. The connector should detect `file://`

When the embedding page is opened as a file rather than served over HTTP, the
browser sends `Origin: null` and the request is refused, with the browser
reporting only an opaque CORS error. `deepjson-js-connector` could check
`window.location.protocol === 'file:'` and say so plainly.

---

## Documentation

### 14. No README, and `package.json` metadata is empty

There is no README, and `description`, `author` and `keywords` in `package.json`
are unfilled. Last open item from the original bug list.

---

## Done

- **`GET /version`** and **`GET /whoami`**, both behind authentication, so each
  doubles as a login check and carries a renewed token. Version is read once from
  `package.json`, so there is a single place to bump it.
- **`X-Powered-By` removed.** It told clients nothing and told scanners which
  stack to aim at.
- **Configurable text body limit.** `express.text()` was silently falling back to
  body-parser's 100kb default, capping the main key-write path well below
  `payload_limit`. Now `text_payload_limit`, then `payload_limit`, then 10mb.
- **Startup config validation** for `dj.config` and `access.json`, collecting every
  problem and reporting them together.
- **Per-group CORS whitelist** via `allowed_origins`, covering both the Express
  middleware and socket.io.
- **Sliding session** through `X-Renewed-Token` on every authenticated response.
- **Script sandbox test battery** in `bin/test-scripting.js`, 17 checks against a
  running server.
