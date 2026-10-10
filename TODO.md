# TODO

Open items found while working through the bug list and testing against a locally
running server. Ordered by how much they hurt, not by effort.

Every entry names where it lives and why it matters. Everything here is verified,
either reproduced against a running server or traced in the code, none of it is
guesswork.

Fixed items are summarized under [Done](#done) rather than kept here. Numbering has
gaps where entries were closed, and the numbers are left as they are so references
to them in commit messages and code comments keep pointing at the right thing; the
full analysis of a closed item is in this file's git history.

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

### 5. `scripts/setup.sh` generates a broken configuration

Four faults, all silent, all in the generated result rather than the script run:

- **`hmac_øauth_settings`** ([line 54](scripts/setup.sh#L54)) contains a `ø`.
  The code reads `hmac_auth_settings`, so `device_auth_enabled: true` is never
  seen and HMAC device authentication is off while the config claims otherwise.
- **`socketServer` nesting** ([line 29](scripts/setup.sh#L29)): the code reads
  `preventDuplicateSessionConnections`, `allowMultipleSessionConnections` and
  `maxClientsPerSession` at the top level. Nested, they do nothing:
  `clients.length >= undefined` is always false, so the per-session client limit
  never applies.
- **Seeded `dj.index` with `#` comments** ([line 87](scripts/setup.sh#L87)):
  `loadIndex()` knows nothing about comment lines and turns them into two real
  index entries keyed `"# Initial DeepJSON index file"` and `"# Format: key"`.
  The file should simply be empty.
- **`emptySessionTTL` is never set.** A `setTimeout` with `undefined` fires almost
  immediately, so empty sessions would be reaped at once.

Also: **`valid_until`** on the device ([line 50](scripts/setup.sh#L50)) is
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

## Missing functionality

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

- **Concurrent writes no longer corrupt documents or lose updates.** Atomic
  temp-file-plus-rename, and modifying requests serialized per key through
  `withKeyLock()`. Measured on the original reproduction: 120 of 120 writes
  survive where 8 did before. Covered by `test/concurrency.test.js`.
- **The index log is bounded.** Compaction reachable via `POST /admin/rotate-index`
  and an optional `index_archiving.rotate_every_hours`; `performIndexRotation()`
  and its retention used to be written but never called. Two latent bugs surfaced
  doing it: a rotation could drop a concurrent append, and the rewritten log had no
  trailing newline so the next append was glued onto the last line. Covered by
  `test/indexRotation.test.js`.
- **File uploads obey `key_payload_limits`.** The limit was a hardcoded 50MB in
  `express-fileupload`, mounted globally so it could not see the key, which made
  the config appear to cover uploads while it silently did not. Now resolved per
  key through `_fileUploadFor()`, mirroring the text parser.
- **A scripted write no longer copies the whole document into the sandbox.** Only
  the context values a script mentions are injected, and whatever is withheld is
  restored afterwards so the round trip callers rely on is preserved. On a 100MB
  document the context went from 200MB to 100MB with the client script unchanged,
  and under 1KB once its redundant `data = data;` is dropped. Three production
  failures came from this. Covered by `test/scriptInjection.test.js`.
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
- **Execute permission no longer confers admin.** `checkAdmin()` returned true for
  any group holding X on any rule, so a group scoped to one key prefix with crudx
  `11111` reached the whole `/admin/*` surface - including `/admin/logs`, which
  returns seven days of request history across every client and is not filtered by
  permission - without being in an admin group and without any rule matching
  `/admin`. Demonstrated with two users differing only in the fifth CRUDX
  character: 200 on every admin route versus 403. It is now group membership only,
  which is what the README already claimed and what keeping X separate in the CRUDX
  model is supposed to mean. Checked before removing it: on a live install the
  `worker` group grants X, so its members held admin unknowingly, and no successful
  `/admin/*` request existed anywhere in the request history, so nothing depended
  on it. Covered by `test/checkAdmin.test.js`.
- **Live `access.json` reload** via `POST /admin/reload-access`. The file used to be
  read once in the constructor, so adding a user meant restarting the database, and
  a JSON typo plus `Restart=always` meant a crash loop until someone fixed the file.
  The reload is all-or-nothing: `collectAccessProblems()` was split out of
  `validateConfig()` so a candidate file can be judged without throwing, and nothing
  is swapped until it parses and validates. CORS and HMAC device auth needed no
  extra wiring, since both read `accessData` per request.
- **A token outliving its user is now rejected.** `authMiddleware()` left `req.user`
  undefined for an unknown `decoded.id` and carried on, which then died inside
  `checkPermissions()` as a 500 that read like a server fault. Tolerable while the
  gap only opened across a restart; with a live reload a removed user has to be
  revoked on their next request, so it returns 401. This changed the behaviour
  recorded by an existing characterization test in `test/auth.test.js`, whose
  original guarantee - that renewal must not crash without a `req.user` - still holds.
- **Script sandbox test battery** in `bin/test-scripting.js`, 17 checks against a
  running server.
