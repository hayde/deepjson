const express = require('express');
const crypto = require('crypto');
const fs = require('fs'); // Regular fs for sync methods
const fsp = require('fs').promises; // Promise-based fs
const path = require('path');
const { getScriptEngine, AVAILABLE_ENGINES, DEFAULT_ENGINE } = require('./lib/scriptEngines');
const moment = require('moment');
const _ = require('lodash');
const https = require('https');
const http = require('http');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fileUpload = require('express-fileupload');
const bytes = require('bytes');
const sharp = require('sharp');
const { Server } = require('socket.io');
const contentDisposition = require('content-disposition');

/**
 * Lock identity for the index log, used with withKeyLock().
 *
 * updateIndex() appends to dj.index while performIndexRotation() rewrites it from
 * the in-memory state. Those two must never overlap: an append landing between
 * rotation's snapshot and its write is present in memory but missing from the
 * file, so it disappears at the next restart.
 *
 * A Symbol rather than a reserved string, so it cannot collide with a document
 * key that happens to be named like an internal sentinel.
 */
const INDEX_LOCK = Symbol('deepjson.indexLog');



/**
 * todo:
 * 20250429 cs  move statement implementation (check in client)
 * 20250429 cs permission check not really valid, please check specially for get with value (script)
 */

/**
 * functionalities
 * 
 * protocolls
 * - http
 * - https
 * 
 * authetication:
 * - jws
 * - HMAC
 * - access.json
 * - device enabling
 * 
 * 
 * 
 */
class DeepJSONServer {

    constructor() {
        this.config = this.loadConfig();
        this.accessData = this.loadAccessData();
        this.index = new Map();
        this.modificationCounter = 0;

        // Tail of the pending operation chain per key, see withKeyLock().
        this._keyLocks = new Map();

        // express server
        this.app = undefined;       // application 
        this.server = undefined;    // listening server

        // socket
        this.io = undefined;        // webSocket
        this.sessions = undefined;  // session map

    }

    /**
     * Version of the running server, taken from package.json so there is exactly
     * one place to bump it and it cannot drift from what is actually deployed.
     *
     * Read once and cached: package.json ships next to this file and does not
     * change while the process runs. If it cannot be read the server still starts,
     * since not knowing the version is never a reason to refuse service.
     */
    getServerVersion() {
        if (this._serverVersion === undefined) {
            try {
                this._serverVersion = require('./package.json').version || null;
            } catch {
                this._serverVersion = null;
            }
        }
        return this._serverVersion;
    }

    /**
     * Body size limit for text/* writes to /keys/:key.
     *
     * `text_payload_limit` in dj.config is optional and only needs to be set when
     * text writes should differ from everything else; otherwise `payload_limit`
     * applies, and if that is missing too, the same 10mb default express.json()
     * uses. Accepts what body-parser accepts: a byte count, or a size string
     * such as "10mb" / "512kb".
     */
    getTextPayloadLimit() {
        return this.config.text_payload_limit || this.config.payload_limit || '10mb';
    }

    /**
     * Body size limit for one specific key, from `key_payload_limits` in dj.config:
     *
     *   "key_payload_limits": [
     *     { "regex": "^uploads\\.bulk\\..*", "limit": "500mb" },
     *     { "regex": "^media\\..*",          "limit": "100mb" },
     *     { "regex": "^.*",                  "limit": "10mb"  }
     *   ]
     *
     * FIRST match wins, so entries run from most specific to least and a catch-all
     * belongs last. This deliberately differs from checkPermissions(), where the
     * last match wins instead, because that ordering surprises everyone who meets
     * it (see TODO item 4).
     *
     * The list is entirely optional, and so is a catch-all inside it. If the list
     * is missing, empty, or nothing matches, the ordinary default applies:
     * text_payload_limit, then payload_limit, then 10mb. So a key that no rule
     * mentions, or a key that does not exist yet, still gets a sane limit rather
     * than none.
     */
    getPayloadLimitForKey(key) {
        const rules = this.config.key_payload_limits;

        if (Array.isArray(rules) && typeof key === 'string') {
            for (const rule of rules) {
                if (!rule || typeof rule.regex !== 'string' || rule.limit === undefined) continue;
                try {
                    if (new RegExp(rule.regex).test(key)) return rule.limit;
                } catch {
                    // A malformed regex is rejected by validateConfig() at startup.
                    // Skipping it here keeps a live server serving rather than
                    // failing every upload over one bad entry.
                }
            }
        }

        return this.getTextPayloadLimit();
    }

    /**
     * body-parser instance for one limit value, cached.
     *
     * The limit is only known once the key is known, so the parser cannot be built
     * at startup like it used to be. Building one per request would re-normalize
     * the options every time, and there are only ever as many distinct limits as
     * the config defines, so they are cached by limit instead.
     */
    _textParserFor(limit) {
        if (!this._textParsers) this._textParsers = new Map();
        let parser = this._textParsers.get(limit);
        if (!parser) {
            parser = express.text({ type: 'text/*', limit });
            this._textParsers.set(limit, parser);
        }
        return parser;
    }

    /**
     * express-fileupload instance for one limit value, cached, mirroring
     * _textParserFor().
     *
     * A file upload is a key write with a multipart body - processFileUpload() is
     * reached only from _handleKeyRequest() - so the same key_payload_limits entry
     * that governs a text write governs the file too, and an operator who sets
     * "350mb" for a key gets it on both paths instead of hitting a hidden floor.
     *
     * fileSize wants a byte count where body-parser accepts the size string
     * directly, hence the bytes.parse(). A limit that somehow fails to parse falls
     * back to 50MB rather than to no limit at all, because unlimited here means one
     * request can exhaust the heap: express-fileupload buffers the whole file, and
     * processFileUpload() then holds a base64 copy of it as well.
     */
    _fileUploadFor(limit) {
        if (!this._fileUploaders) this._fileUploaders = new Map();
        let uploader = this._fileUploaders.get(limit);
        if (!uploader) {
            const fileSize = (typeof limit === 'number' ? limit : bytes.parse(limit))
                || 50 * 1024 * 1024;
            uploader = fileUpload({
                limits: { fileSize },
                abortOnLimit: true
            });
            this._fileUploaders.set(limit, uploader);
        }
        return uploader;
    }

    /**
     * Whether a write is flushed to disk before it is acknowledged, from
     * `durability` in dj.config ("sync" or "async").
     *
     * Defaults to "sync". Atomic rename already guarantees a reader never sees a
     * half-written document, but it says nothing about the write having reached the
     * disk: without a flush, the kernel may still be holding it in the page cache
     * when the power goes, and a client that was told 200 loses its data. For
     * anything described as a transaction that default has to be the safe one.
     */
    /**
     * Entity-tag for a stored document, from its own `_modCounter`.
     *
     * `_modCounter` is used rather than the server-global modificationCounter
     * because it lives inside the document: it survives rebuild-index, a restore
     * from backup and an index rotation. The global counter does not - a rebuild
     * derives it from these values and renumbers, so an ETag built on it would
     * silently become wrong after a restore.
     */
    etagFor(data) {
        return `"${(data && data._modCounter) || 0}"`;
    }

    /**
     * Strong comparison of an If-Match / If-None-Match header against the current
     * entity-tag, with `null` meaning the key does not exist.
     *
     * Lenient on input, strict on output: the header may arrive unquoted or with a
     * W/ prefix, which clients get wrong often enough that refusing is unhelpful,
     * while what the server emits is always a correctly quoted tag.
     */
    etagMatches(headerValue, currentEtag) {
        const normalize = (v) => String(v).trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
        const raw = String(headerValue).trim();

        // "*" asks whether any representation exists at all.
        if (raw === '*') return currentEtag !== null;
        if (currentEtag === null) return false;

        const current = normalize(currentEtag);
        return raw.split(',').some(candidate => normalize(candidate) === current);
    }

    /**
     * Evaluates the conditional-request headers against the document as it is right
     * now, returning a 412 descriptor when the precondition fails.
     *
     * This closes the lost-update gap that per-key locking cannot: the lock covers
     * one request, so a client that reads, decides something, and writes in a
     * second request can still be overtaken in between. With If-Match the second
     * request carries the version the decision was based on, and the server refuses
     * if it has moved.
     *
     * MUST be called from inside withKeyLock(), after the document has been read.
     * Evaluated earlier it would compare against a version that can change before
     * the write lands, which is exactly the race being closed.
     *
     * If-Match takes precedence over If-None-Match, per RFC 9110 section 13.2.2.
     */
    evaluatePreconditions(req, currentEtag) {
        const ifMatch = req.headers['if-match'];
        const ifNoneMatch = req.headers['if-none-match'];

        if (ifMatch === undefined && ifNoneMatch === undefined) return null;

        if (ifMatch !== undefined) {
            if (this.etagMatches(ifMatch, currentEtag)) return null;
            return {
                status: 412,
                error: {
                    error: 'Precondition failed: the key has changed since the version supplied in If-Match',
                    expected: ifMatch,
                    current: currentEtag
                }
            };
        }

        // If-None-Match carries two different meanings depending on the method, and
        // conflating them breaks ordinary browser caching.
        //
        // On a write it is the conditional create: "store this only if the key does
        // not already exist", and a match is a failure worth reporting.
        //
        // On a read it is cache revalidation: "I already hold this version, has it
        // changed?" - and a match is the *good* answer. A browser asks this on every
        // second view of an image or PDF it has cached, and RFC 9110 section 13.1.2
        // requires 304 Not Modified with no body for GET and HEAD, and 412 only for
        // other methods. Answering 412 here made the browser render the error JSON in
        // place of the document, and only on the second view, which is what made it
        // look intermittent.
        if (!this.etagMatches(ifNoneMatch, currentEtag)) return null;

        if (req.method === 'GET' || req.method === 'HEAD') {
            // No body, and no error: the caller already set the ETag header, which a
            // 304 should carry so the client can keep revalidating.
            return { status: 304 };
        }

        return {
            status: 412,
            error: {
                error: 'Precondition failed: the key matches If-None-Match',
                current: currentEtag
            }
        };
    }

    isSyncDurability() {
        return (this.config.durability || 'sync') !== 'async';
    }

    /**
     * Writes a file and, in sync mode, flushes it before returning.
     *
     * fsp.writeFile() hands back no descriptor, so the flush needs the file opened
     * explicitly. Measured cost on a plain SSD volume: about 1.2ms per flush.
     */
    async writeFileDurable(filePath, payload) {
        const handle = await fsp.open(filePath, 'w');
        try {
            await handle.writeFile(payload);
            if (this.isSyncDurability()) await handle.sync();
        } finally {
            await handle.close();
        }
    }

    /**
     * Flushes a directory entry, which is what makes a rename() itself durable:
     * the renamed file's contents can be on disk while the directory entry
     * pointing at it is not, and then the file reverts to its old name on recovery.
     *
     * Failures are swallowed on purpose. Flushing a directory is a Linux
     * behaviour that some filesystems refuse outright, and by this point the
     * document's contents are already flushed and renamed - the worst case is
     * losing the rename, not corrupting anything, so it must not fail the write.
     */
    async fsyncDirectory(dirPath) {
        if (!this.isSyncDurability()) return;
        let handle;
        try {
            handle = await fsp.open(dirPath, 'r');
            await handle.sync();
        } catch {
            // platform or filesystem limitation, see above
        } finally {
            if (handle) await handle.close().catch(() => {});
        }
    }

    /**
     * Flushes the index log.
     *
     * Deliberately called *after* INDEX_LOCK has been released. The lock exists so
     * a rotation cannot rewrite the log while an append is in flight; it does not
     * need to cover the flush. The append is a single atomic O_APPEND write, so by
     * the time it returns the ordering is settled, and a rotation builds its new
     * file from the in-memory index, which already contains that entry.
     *
     * Holding the flush inside the lock instead would serialize every write in the
     * server on one ~1.2ms flush - a global ceiling near 800 writes/sec no matter
     * how many distinct keys are involved. Outside it, flushes overlap on the
     * libuv threadpool and only same-key writes serialize, as they already did.
     */
    async fsyncIndexLog() {
        if (!this.isSyncDurability()) return;
        let handle;
        try {
            handle = await fsp.open(this.getCurrentIndexPath(), 'r');
            await handle.sync();
        } catch {
            // the log may not exist yet on a brand new install
        } finally {
            if (handle) await handle.close().catch(() => {});
        }
    }

    loadConfig() {
        const configPath = process.argv[2] || '/etc/deepjson/dj.config';
        // Use sync method during initialization
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (err) {
            // Without this the operator gets a bare ENOENT or "Unexpected token"
            // with no hint as to which file the server was even looking for.
            throw new Error(`Could not load config "${configPath}": ${err.message}`);
        }
    }

    loadAccessData() {
        const accessPath = this.config.access_file;
        try {
            return JSON.parse(fs.readFileSync(accessPath, 'utf8'));
        } catch (err) {
            throw new Error(`Could not load access_file "${accessPath}": ${err.message}`);
        }
    }

    async initialize() {
        this.validateConfig();
        await this.createDirectories();
        await this.loadIndex();
        // After loadIndex(), deliberately: this one reports against the keys that
        // actually exist, which validateConfig() cannot see because it runs first.
        this.warnAboutCrossGroupRevocations();
        this.setupServer();
        this.startIndexRotationSchedule();
    }

    /**
     * Finds keys where one group grants a permission and another group, listed
     * later on the same user, takes it away.
     *
     * checkPermissions() reassigns its verdict on every matching rule, so the LAST
     * match decides - and it walks groups in the order `user.groups` happens to
     * list them. Within one group that is a deliberate, documented idiom: grant a
     * prefix, then deny a narrower one underneath it. Across groups it is a trap,
     * because the order comes from an arbitrary JSON array, so adding a group to a
     * user can silently revoke access they already had, and swapping two entries
     * changes who can read what. Only the cross-group case is reported here;
     * flagging the idiom as well would make the warning noise, and noise gets
     * ignored.
     *
     * Checked against real keys rather than by comparing patterns, so there are no
     * false positives: every key reported genuinely resolves that way today.
     * Capped, because this walks keys x rules and an index can be large.
     */
    findCrossGroupRevocations({ limit = 50000 } = {}) {
        const OPS = ['C', 'R', 'U', 'D', 'X'];
        const findings = [];

        for (const [userId, user] of Object.entries(this.accessData.users || {})) {
            // Flattened in evaluation order, with the owning group attached, so the
            // walk below mirrors exactly what checkPermissions() does.
            const rules = [];
            for (const groupName of (user.groups || [])) {
                for (const rule of (this.accessData.groups?.[groupName]?.rules || [])) {
                    // A rule carrying neither crudx nor crud never changes the
                    // verdict, so it cannot revoke anything.
                    const crudx = rule.crudx || (rule.crud !== undefined ? `${rule.crud}1` : undefined);
                    if (!crudx) continue;
                    try {
                        rules.push({ group: groupName, regex: rule.regex, crudx, matcher: new RegExp(rule.regex) });
                    } catch {
                        // validateConfig() already rejects an uncompilable regex.
                    }
                }
            }
            if (rules.length < 2) continue;

            const counts = new Map();
            let example = null;
            let scanned = 0;

            for (const key of this.index.keys()) {
                if (scanned >= limit) break;
                scanned++;

                const matched = rules.filter(r => r.matcher.test(key));
                if (matched.length < 2) continue;

                const decider = matched[matched.length - 1];

                for (let i = 0; i < OPS.length; i++) {
                    if (decider.crudx[i] === '1') continue;          // nothing taken away
                    const grantor = matched.find(r => r.crudx[i] === '1' && r.group !== decider.group);
                    if (!grantor) continue;                          // same group: the idiom

                    counts.set(OPS[i], (counts.get(OPS[i]) || 0) + 1);
                    if (!example) example = { key, operation: OPS[i], grantedBy: grantor, revokedBy: decider };
                }
            }

            if (counts.size) {
                findings.push({ userId, counts, example, scanned, sampled: scanned >= limit });
            }
        }

        return findings;
    }

    warnAboutCrossGroupRevocations() {
        const findings = this.findCrossGroupRevocations();

        for (const finding of findings) {
            const affected = [...finding.counts.entries()]
                .map(([op, n]) => `${op} on ${n} key${n === 1 ? '' : 's'}`)
                .join(', ');
            const { key, operation, grantedBy, revokedBy } = finding.example;

            console.warn(
                `Permission warning: user "${finding.userId}" is denied ${affected} by a group listed ` +
                `after the one that granted it. The last matching rule wins and groups are walked in the ` +
                `order the user lists them, so adding or reordering a group can change this. ` +
                `Example: "${key}" - ${operation} granted by group "${grantedBy.group}" rule ` +
                `${JSON.stringify(grantedBy.regex)}, then denied by group "${revokedBy.group}" rule ` +
                `${JSON.stringify(revokedBy.regex)}. GET /whoami?keys=... is the authoritative answer.` +
                (finding.sampled ? ` (first ${finding.scanned} keys checked)` : '')
            );
        }

        return findings;
    }

    /**
     * Optional periodic compaction, driven by
     * index_archiving.rotate_every_hours. Off unless configured, so an existing
     * install keeps behaving exactly as before and an operator opts in; the admin
     * route stays available either way.
     *
     * unref() so a pending timer never holds the process open at shutdown, and
     * failures are logged rather than thrown, because an unhandled rejection in a
     * background timer would take the server down over a housekeeping task.
     */
    startIndexRotationSchedule() {
        const hours = Number(this.config.index_archiving?.rotate_every_hours);
        if (!(hours > 0)) return null;

        this._indexRotationTimer = setInterval(() => {
            this.performIndexRotation().then(
                (result) => console.log(
                    `Index rotated: ${result.keys} keys, ${result.bytesBefore} -> ${result.bytesAfter} bytes`
                ),
                (err) => console.error('Scheduled index rotation failed:', err.message)
            );
        }, hours * 60 * 60 * 1000);
        this._indexRotationTimer.unref();

        return this._indexRotationTimer;
    }

    /**
     * Fails fast on a broken dj.config or access.json, so the operator learns about
     * it while the server is starting rather than when some unrelated request
     * happens to hit the broken part. script_engine is the motivating example: it is
     * only read inside executeScript(), so a typo there used to start up perfectly
     * and then break the first script someone ran, looking like a script bug.
     *
     * Everything is collected first and reported together, so a misconfigured
     * install can be fixed in one pass rather than one restart per mistake.
     * Fatal = the server cannot work correctly; warnings are printed and startup
     * continues.
     */
    validateConfig() {
        const errors = [];
        const warnings = [];
        const cfg = this.config || {};
        const access = this.accessData || {};

        const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
        const requireText = (value, name) => {
            if (typeof value !== 'string' || value.trim() === '') {
                errors.push(`${name} is required and must be a non-empty string`);
                return false;
            }
            return true;
        };
        const requireInt = (value, name, { min, max }) => {
            const n = Number(value);
            if (!Number.isInteger(n) || n < min || n > max) {
                errors.push(`${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(value)})`);
                return false;
            }
            return true;
        };

        /* ---- dj.config ---- */

        requireText(cfg.data_root, 'data_root');
        requireText(cfg.access_file, 'access_file');

        if (requireText(cfg.jwt_secret, 'jwt_secret') && cfg.jwt_secret.length < 32) {
            warnings.push(`jwt_secret is only ${cfg.jwt_secret.length} characters; use a long random value (32+)`);
        }

        if (cfg.ssl?.enabled) {
            requireInt(cfg.ssl.port, 'ssl.port', { min: 1, max: 65535 });
            for (const field of ['key', 'cert']) {
                if (requireText(cfg.ssl[field], `ssl.${field}`) && !fs.existsSync(cfg.ssl[field])) {
                    errors.push(`ssl.${field} points to a file that does not exist: ${cfg.ssl[field]}`);
                }
            }
        } else {
            requireInt(cfg.port, 'port', { min: 1, max: 65535 });
        }

        // A sha256 hex digest is 64 characters and getKeyPath() consumes two per
        // level, so more than 32 levels cannot be built from it.
        requireInt(cfg.index_depth, 'index_depth', { min: 1, max: 32 });

        // Byte sizes are handed straight to body-parser, which parses them with the
        // `bytes` package. That package is only a transitive dependency here, so it
        // must not be required directly just to validate; the shape is checked with
        // a pattern instead.
        const checkByteSize = (value, name) => {
            if (value === undefined) return;
            if (typeof value === 'number') {
                if (!(value > 0)) {
                    errors.push(`${name} must be a positive number of bytes (got ${JSON.stringify(value)})`);
                }
                return;
            }
            if (typeof value !== 'string' || !/^\s*\d+(\.\d+)?\s*(b|kb|mb|gb|tb|pb)?\s*$/i.test(value)) {
                errors.push(`${name} must be a byte count or a size string like "10mb" / "512kb" (got ${JSON.stringify(value)})`);
            }
        };
        checkByteSize(cfg.payload_limit, 'payload_limit');
        checkByteSize(cfg.text_payload_limit, 'text_payload_limit');

        if (cfg.key_list_limit !== undefined
            && !(Number.isInteger(Number(cfg.key_list_limit)) && Number(cfg.key_list_limit) > 0)) {
            errors.push(`key_list_limit must be a positive integer number of keys (got ${JSON.stringify(cfg.key_list_limit)})`);
        }

        if (cfg.durability !== undefined && !['sync', 'async'].includes(cfg.durability)) {
            errors.push(`durability must be "sync" or "async" (got ${JSON.stringify(cfg.durability)})`);
        }
        if (cfg.durability === 'async') {
            // Said out loud at startup, because the failure it allows is silent:
            // the client is told the write succeeded and nothing looks wrong until
            // a power loss takes the last few seconds of writes with it.
            warnings.push(
                'durability is "async", so writes are acknowledged before reaching disk; ' +
                'a power loss or hard reset can lose recently confirmed writes'
            );
        }

        if (cfg.key_payload_limits !== undefined) {
            if (!Array.isArray(cfg.key_payload_limits)) {
                errors.push('key_payload_limits must be an array of { regex, limit } entries');
            } else {
                cfg.key_payload_limits.forEach((rule, i) => {
                    const where = `key_payload_limits[${i}]`;
                    if (!isPlainObject(rule)) {
                        errors.push(`${where} must be an object with "regex" and "limit"`);
                        return;
                    }
                    if (typeof rule.regex !== 'string') {
                        errors.push(`${where}.regex is required and must be a string`);
                    } else {
                        try {
                            new RegExp(rule.regex);
                        } catch (err) {
                            errors.push(`${where}.regex does not compile: ${err.message}`);
                        }
                    }
                    checkByteSize(rule.limit, `${where}.limit`);
                    if (rule.limit === undefined) {
                        errors.push(`${where}.limit is required`);
                    }

                    // A catch-all swallows everything after it, since the first
                    // match wins. Almost always a mistake unless it is last.
                    if (/^\^?\.\*\$?$/.test(rule.regex) && i < cfg.key_payload_limits.length - 1) {
                        warnings.push(
                            `${where} is a catch-all ("${rule.regex}") but ${cfg.key_payload_limits.length - 1 - i} ` +
                            'entries follow it; first match wins, so those can never apply'
                        );
                    }

                    // A single string cannot exceed 512MB in V8, and a document is
                    // serialized whole before being written, with escaping adding
                    // to it. Anything approaching that fails at write time in a way
                    // that depends on the content, so it is worth saying up front.
                    const mb = typeof rule.limit === 'string' && /^(\d+(?:\.\d+)?)\s*mb$/i.exec(rule.limit);
                    const bytes = mb ? Number(mb[1]) * 1024 * 1024 : (typeof rule.limit === 'number' ? rule.limit : 0);
                    if (bytes > 256 * 1024 * 1024) {
                        warnings.push(
                            `${where}.limit is ${rule.limit}; documents are serialized as one string and V8 refuses ` +
                            'any string over 512MB, so large payloads can fail at write time depending on how much ' +
                            'JSON escaping their content needs'
                        );
                    }
                });
            }
        }

        if (cfg.script_engine !== undefined && !AVAILABLE_ENGINES.includes(cfg.script_engine)) {
            errors.push(
                `script_engine "${cfg.script_engine}" is unknown. Valid options: ` +
                `${AVAILABLE_ENGINES.map(e => `"${e}"`).join(', ')} (omit the key to use "${DEFAULT_ENGINE}")`
            );
        }

        if (cfg.script_execution_time_limit !== undefined
            && !(Number(cfg.script_execution_time_limit) > 0)) {
            errors.push(`script_execution_time_limit must be a positive number of milliseconds (got ${JSON.stringify(cfg.script_execution_time_limit)})`);
        }

        if (cfg.index_archiving !== undefined) {
            if (!isPlainObject(cfg.index_archiving)) {
                errors.push('index_archiving must be an object with older_than_days and/or archiving_url');
            } else {
                const { older_than_days, archiving_url, rotate_every_hours } = cfg.index_archiving;
                if (older_than_days !== undefined && !(Number(older_than_days) > 0)) {
                    errors.push(`index_archiving.older_than_days must be a positive number of days (got ${JSON.stringify(older_than_days)})`);
                }
                if (older_than_days === undefined && !archiving_url) {
                    warnings.push('index_archiving is set but has no older_than_days, so no archive snapshots will ever be deleted');
                }
                if (rotate_every_hours !== undefined && !(Number(rotate_every_hours) > 0)) {
                    errors.push(`index_archiving.rotate_every_hours must be a positive number of hours (got ${JSON.stringify(rotate_every_hours)})`);
                }
                // Retention only ever runs as part of a rotation, so a day count
                // without a schedule deletes nothing unless /admin/rotate-index is
                // called by hand. Worth saying, since it reads as self-acting.
                if (older_than_days !== undefined && rotate_every_hours === undefined) {
                    warnings.push(
                        'index_archiving.older_than_days is set but rotate_every_hours is not, so retention ' +
                        'only runs when POST /admin/rotate-index is called manually'
                    );
                }
                if (archiving_url !== undefined && archiving_url !== null && typeof archiving_url !== 'string') {
                    errors.push('index_archiving.archiving_url must be a string or null');
                }
                if (archiving_url) {
                    warnings.push('index_archiving.archiving_url is set but not implemented yet; only older_than_days is applied');
                }
            }
        }

        /* ---- access.json ---- */

        const accessProblems = this.collectAccessProblems(access);
        errors.push(...accessProblems.errors);
        warnings.push(...accessProblems.warnings);

        warnings.forEach(w => console.warn(`Config warning: ${w}`));

        if (errors.length) {
            throw new Error(
                `Invalid configuration (${errors.length} problem${errors.length > 1 ? 's' : ''}):\n` +
                errors.map(e => `  - ${e}`).join('\n')
            );
        }
    }

    /**
     * Collects every problem with an access.json shape, without throwing.
     *
     * Split out of validateConfig() so the same checks can judge a *candidate*
     * file: reloadAccessData() has to be able to reject a broken file and keep
     * serving with the access data it already has, which it cannot do if the only
     * way to validate is a method that throws.
     */
    collectAccessProblems(access) {
        const errors = [];
        const warnings = [];
        const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

        access = access || {};


        if (!isPlainObject(access.users)) {
            errors.push('access_file: "users" is missing or not an object');
        } else if (Object.keys(access.users).length === 0) {
            warnings.push('access_file: "users" is empty, nobody can log in');
        }

        if (!isPlainObject(access.groups)) {
            errors.push('access_file: "groups" is missing or not an object');
        }

        if (isPlainObject(access.users) && isPlainObject(access.groups)) {
            for (const [userId, user] of Object.entries(access.users)) {
                if (!Array.isArray(user?.groups)) {
                    errors.push(`access_file: user "${userId}" has no "groups" array`);
                    continue;
                }
                for (const group of user.groups) {
                    // checkPermissions() reads groups[group].rules directly, so an
                    // unknown group name is a TypeError on the next request.
                    if (!(group in access.groups)) {
                        errors.push(`access_file: user "${userId}" references unknown group "${group}"`);
                    }
                }
                if (user.password === undefined) {
                    errors.push(`access_file: user "${userId}" has no password`);
                } else if (typeof user.password === 'string' && !user.password.startsWith('scrypt:')) {
                    errors.push(`access_file: user "${userId}" has a password that is not a scrypt hash; run hashPassword() and store the result`);
                }
            }
        }

        if (isPlainObject(access.groups)) {
            for (const [groupName, group] of Object.entries(access.groups)) {
                if (!Array.isArray(group?.rules)) {
                    warnings.push(`access_file: group "${groupName}" has no "rules" array, it grants nothing`);
                } else {
                    group.rules.forEach((rule, i) => {
                        const where = `access_file: group "${groupName}" rule #${i + 1}`;
                        try {
                            new RegExp(rule?.regex);
                        } catch (err) {
                            errors.push(`${where} has an invalid regex: ${err.message}`);
                        }
                        if (rule?.crudx !== undefined && !/^[01]{5}$/.test(rule.crudx)) {
                            errors.push(`${where} has crudx "${rule.crudx}", expected 5 characters of 0/1`);
                        } else if (rule?.crudx === undefined && rule?.crud !== undefined && !/^[01]{4}$/.test(rule.crud)) {
                            errors.push(`${where} has crud "${rule.crud}", expected 4 characters of 0/1`);
                        } else if (rule?.crudx === undefined && rule?.crud === undefined) {
                            errors.push(`${where} has neither "crudx" nor "crud"`);
                        }
                    });
                }

                if (group?.allowed_origins !== undefined) {
                    if (!Array.isArray(group.allowed_origins)) {
                        errors.push(`access_file: group "${groupName}" has an "allowed_origins" that is not an array`);
                    } else {
                        group.allowed_origins.forEach((origin, i) => {
                            // The silent killer: a bare JSON null (or any non-string)
                            // still counts toward the whitelist size, so the
                            // open-by-default fallback stays off while the entry can
                            // never match. See isOriginAllowed() for the "null" case.
                            if (typeof origin !== 'string' || origin.trim() === '') {
                                errors.push(
                                    `access_file: group "${groupName}" allowed_origins[${i}] is ${JSON.stringify(origin)}; ` +
                                    'entries must be non-empty strings (to allow a file:// page use the quoted string "null")'
                                );
                            }
                        });
                    }
                }
            }
        }

        return { errors, warnings };
    }

    /**
     * Re-reads access_file and swaps it in, so adding a user or changing a
     * permission no longer needs a restart of the whole database.
     *
     * Deliberately explicit rather than an fs.watch: a watcher fires on the
     * partial file a text editor leaves mid-save, and there is no good way to
     * report the resulting parse error to anyone.
     *
     * Nothing is swapped until the new file parses AND validates. A bad file
     * leaves the running server exactly as it was, which is the whole point -
     * the alternative is today's behaviour, where a typo plus a restart takes the
     * database down until someone fixes the JSON.
     *
     * Not cached anywhere: getAllowedCorsOrigins() and the HMAC device lookup both
     * read this.accessData per request, so CORS and device auth pick the new data
     * up with no further wiring. Tokens already issued stay valid, since they are
     * signed with jwt_secret and carry only an id - but a user removed from the
     * file is now rejected on their next request, see authMiddleware().
     */
    async reloadAccessData() {
        const accessPath = this.config.access_file;

        let candidate;
        try {
            candidate = JSON.parse(await fsp.readFile(accessPath, 'utf8'));
        } catch (err) {
            const error = new Error(`Could not reload access_file "${accessPath}": ${err.message}`);
            error.code = 'ACCESS_RELOAD_FAILED';
            throw error;
        }

        const { errors, warnings } = this.collectAccessProblems(candidate);
        if (errors.length) {
            const error = new Error(
                `Refusing to reload access_file (${errors.length} problem${errors.length > 1 ? 's' : ''}); ` +
                'the previous access data is still in effect'
            );
            error.code = 'ACCESS_RELOAD_FAILED';
            error.problems = errors;
            throw error;
        }

        warnings.forEach(w => console.warn(`Access reload warning: ${w}`));

        const previous = this.accessData;
        this.accessData = candidate;

        return {
            users: Object.keys(candidate.users || {}).length,
            groups: Object.keys(candidate.groups || {}).length,
            devices: Object.keys(candidate.devices || {}).length,
            usersBefore: Object.keys(previous?.users || {}).length,
            warnings
        };
    }

    async createDirectories() {
        const base = this.config.data_root;
        await fsp.mkdir(path.join(base, 'data'), { recursive: true });
        await fsp.mkdir(path.join(base, 'index'), { recursive: true });
        await fsp.mkdir(path.join(base, 'index', 'archive'), { recursive: true });
        await fsp.mkdir(path.join(base, 'logs'), { recursive: true });
        await fsp.mkdir(path.join(base, 'scripts'), { recursive: true });
    }

    /**
     * setup the express server
     */
    setupServer() {
        this.app = express();

        // Express advertises itself with X-Powered-By on every response. It tells a
        // client nothing useful and tells a scanner which stack to target, so it goes.
        this.app.disable('x-powered-by');

        // Core middleware
        this.app.use(express.json({ limit: this.config.payload_limit || '10mb' }));

        // key requests could be text.
        //
        // The limit has to be passed explicitly: without it express.text() falls
        // back to body-parser's built-in 100kb default, which is far below
        // payload_limit and silently caps the main key-write path (writing a key
        // as text/* is the working route, so this limit is the one users hit).
        //
        // It is resolved per request rather than once at startup, because
        // key_payload_limits lets it depend on which key is being written. See
        // getPayloadLimitForKey() for the precedence.
        this.app.use('/keys/:key', (req, res, next) => {
            const limit = this.getPayloadLimitForKey(req.params.key);
            return this._textParserFor(limit)(req, res, next);
        });

        // Same resolution for multipart file uploads, which used to run through a
        // globally mounted express-fileupload pinned to 50MB. It was mounted before
        // any route matched, so req.params.key did not exist yet and the limit could
        // not depend on the key - which made key_payload_limits look like it covered
        // uploads while it silently did not. Scoping it here is safe: req.files is
        // read only by processFileUpload(), which no route outside /keys/:key
        // reaches. express.text() above ignores multipart bodies, so the two
        // parsers do not collide.
        this.app.use('/keys/:key', (req, res, next) => {
            const limit = this.getPayloadLimitForKey(req.params.key);
            return this._fileUploadFor(limit)(req, res, next);
        });

        // exposedHeaders: X-Renewed-Token carries the sliding-session token
        // (see authMiddleware()) - without this, browser-based clients can't
        // read it, even though the header is present in the raw response.
        //
        // origin: per-group allowlist (see getAllowedCorsOrigins()) for cases like
        // an <img>/fetch pointing straight at a resized image's URL from another
        // domain, outside the normal API-client flow. CORS itself can't be scoped
        // to "this group only" - the browser's preflight carries no auth, so the
        // server can't yet know which user/group is asking. What this actually
        // enforces is the union of every group's allowed_origins, as one global
        // whitelist; group membership only organizes which origin belongs to
        // which client app in access.json, it isn't checked per request here.
        // Backward-compatible default: if no group defines allowed_origins at all,
        // every origin is still allowed, same as before this change.
        this.app.use(cors({
            origin: (origin, callback) => {
                if (this.isOriginAllowed(origin)) return callback(null, true);
                callback(new Error(`Origin not allowed by CORS: ${origin}`));
            },
            exposedHeaders: ['X-Renewed-Token']
        }));
        this.app.use((req, res, next) => {
            if (req.secure) {
                res.setHeader('Strict-Transport-Security', 'max-age=31536000');
            }
            next();
        });


        // Add login route 
        this.app.post('/auth/login', this.handleLogin.bind(this));
        // Add middleware
        this.app.use(this.authMiddleware.bind(this)); // first usage of the route: check authentification

        // here we add the header checking for the system
        this.app.use((req, res, next) => {
            res.locals = res.locals || {};
            res.locals.overwriteMethod = this._hasaOverwriteMethod(req);
            res.locals.fileUpload = this._isFileUpload(req);
            res.locals.binaryRequest = this._isBinaryRequest(req);
            res.locals.overwriteExisting = this._hasOverwriteExisting(req);
            res.locals.image = this._hasImageModulation(req);

            // if it is a file upload, the binary flag is not relevant. Creates an issue!
            if (res.locals.fileUpload) res.locals.binaryRequest = false;
            next();
        });

        // Identity and build info. Both sit behind authMiddleware, so they double as
        // a login check, and each response carries a fresh X-Renewed-Token.
        this.app.get('/version', this.handleVersion.bind(this));
        this.app.get('/whoami', this.handleWhoami.bind(this));

        // Core routes
        this.app.route('/keys/:key')
            .get(this.handleKeyRequest.bind(this))
            .post(this.handleKeyRequest.bind(this))
            .put(this.handleKeyRequest.bind(this))
            .delete(this.handleKeyRequest.bind(this));

        // move route
        this.app.post('/cmd/move', this.handleMove.bind(this));
        this.app.route('/cmd/keys/')
            .get(this.handleListKeys.bind(this))
            .post(this.handleListKeys.bind(this));

        // Admin routes
        this.setupAdminRoutes();

        // Create servers
        if (this.config.ssl?.enabled) {
            const sslOptions = {
                key: fs.readFileSync(this.config.ssl.key),
                cert: fs.readFileSync(this.config.ssl.cert)
            };
            this.server = https.createServer(sslOptions, this.app);
        } else {
            this.server = http.createServer(this.app);
        }


        // attack web sockets to the server
        this._setupSocketServer(this.server);


        // Start listening
        const port = this.config.ssl?.enabled
            ? this.config.ssl.port
            : this.config.port;

        console.log( "Starting Listener" );
        this.server.listen(port, () => {
            console.log(`Listening on ${this.config.ssl?.enabled ? 'HTTPS' : 'HTTP'} port ${port}`);
        });

    }

    /**
     * SocketServer implementation
     * @param expressServer 
     */
    _setupSocketServer(expressServer) {
        this.io = new Server(expressServer, {
            // socket.io keeps its own CORS config, separate from the Express
            // middleware above - restricting one does not restrict the other.
            //
            // This covers BOTH transports: unlike a raw browser WebSocket, where
            // CORS is never enforced, engine.io runs this check itself on the
            // handshake, so a client using transports: ['websocket'] to skip
            // polling is rejected here too (verified against both transports).
            //
            // No exposedHeaders here on purpose: the handshake authenticates once
            // via the query-parameter token and never renews it, so there is no
            // X-Renewed-Token to hand back (see authMiddleware()).
            cors: {
                origin: (origin, callback) => {
                    if (this.isOriginAllowed(origin)) return callback(null, true);
                    callback(new Error(`Origin not allowed by CORS: ${origin}`));
                },
                methods: ["GET", "POST"],
                allowedHeaders: ["Authorization", "Content-Type"],
                credentials: false
            }
        });
        this.sessions = new Map();

        this.io.on('connection', (socket) => {
            const token = socket.handshake.query.token;
            const action = socket.handshake.query.action;
            let channelId = socket.handshake.query.channelId;
            let user = null;

            // Authentication remains the same
            try {
                const decoded = jwt.verify(token, this.config.jwt_secret);
                user = this.accessData.users[decoded.id];
                if (!user) throw new Error('User not found');
            } catch (err) {
                socket.emit('error', { code: 'AUTH_FAILED', message: 'Invalid authentication' });
                socket.disconnect();
                return;
            }

            // New session validation logic
            if (action === 'connect' && channelId) {
                const session = this.sessions.get(channelId);

                if (session && this.config.preventDuplicateSessionConnections) {
                    const isAlreadyInSession = session.clients.some(c => c.user.id === user.id) ||
                        session.master.user.id === user.id;

                    if (isAlreadyInSession && !this.config.allowMultipleSessionConnections) {
                        socket.emit('error', {
                            code: 'ALREADY_IN_SESSION',
                            message: 'User already participating in this session'
                        });
                        socket.disconnect();
                        return;
                    }
                }
            }

            // Rest of the original logic remains unchanged
            if (action === 'create') {
                channelId = this._createNewSession(socket, user);
                socket.emit('session-created', { channelId });
            } else if (action === 'connect') {
                if (!this._validateSessionJoin(socket, channelId, user)) return;
            } else {
                socket.emit('error', { code: 'INVALID_ACTION', message: 'Missing or invalid action' });
                socket.disconnect();
                return;
            }

            const session = this.sessions.get(channelId);
            this._setupSessionHandlers(socket, session, user);
        });
    }

    _createNewSession(socket, user) {
        const generateId = () => {
            const chars = 'abcdefghijkmnpqrstuvwxyz0123456789';
            let id = '';
            for (let i = 0; i < 5; i++) {
                const idx = crypto.randomInt(0, chars.length);
                id += chars[idx];
            }
            return id;
        };
    
        let channelId;
        do {
            channelId = generateId();
        } while (this.sessions.has(channelId)); // retry if ID already exists
    
        const session = {
            channelId,
            master: { socket, user },
            clients: [],
            created: Date.now(),
            lastActivity: Date.now(),
            metadata: {}
        };
    
        this.sessions.set(channelId, session);
        return channelId;
    }

    _validateSessionJoin(socket, channelId, user) {
        if (!channelId || !this.sessions.has(channelId)) {
            socket.emit('error', {
                code: 'INVALID_SESSION',
                message: `Session ${channelId} does not exist`
            });
            socket.disconnect();
            return false;
        }

        const session = this.sessions.get(channelId);
        if (session.clients.length >= this.config.maxClientsPerSession) {
            socket.emit('error', { code: 'SESSION_FULL', message: 'Session reached maximum capacity' });
            socket.disconnect();
            return false;
        }
        return true;
    }

    _setupSessionHandlers(socket, session, user) {
        // Add client to session
        const clientInfo = { socket, user, joined: Date.now() };
        if (socket === session.master.socket) {
            session.master.socket = socket; // Refresh socket reference
        } else {
            session.clients.push(clientInfo);
        }

        // Initialization
        socket.emit('session-joined', {
            channelId: session.channelId,
            isMaster: socket === session.master.socket,
            participants: this._getParticipantList(session)
        });

        // Broadcast new participant to others
        this._broadcast(session, 'participant-joined', {
            userId: user.id,
            timestamp: Date.now()
        }, socket);

        // Message handling
        socket.on('message', (payload) => {
            session.lastActivity = Date.now();
            if (typeof payload !== 'object' || payload === null) {
                return socket.emit('error', { code: 'INVALID_PAYLOAD' });
            }
            this._broadcast(session, payload.type, payload.data, socket);
        });

        // Disconnection handling
        socket.on('disconnect', () => {
            if (socket === session.master.socket) {
                this._handleMasterDisconnect(session);
            } else {
                this._handleClientDisconnect(session, socket);
            }
        });
    }

    _broadcast(session, type, data, excludeSocket = null) {
        const payload = { type, data, timestamp: Date.now() };

        // Send to master
        if (session.master.socket !== excludeSocket) {
            session.master.socket.emit('message', payload);
        }

        // Send to clients
        session.clients.forEach(client => {
            if (client.socket !== excludeSocket && client.socket.connected) {
                client.socket.emit('message', payload);
            }
        });
    }

    _handleMasterDisconnect(session) {
        // Notify all clients
        this._broadcast(session, 'session-ended', {
            reason: 'Master disconnected'
        });

        // Disconnect all clients
        session.clients.forEach(client => {
            client.socket.disconnect();
        });

        // Cleanup session
        this.sessions.delete(session.channelId);
    }

    _handleClientDisconnect(session, socket) {
        var leaving_user = session.clients.filter(c => c.socket === socket);
        if (leaving_user.length === 0) {
            // there is no user like that!
        } else {
            // get the first element
            leaving_user = leaving_user[0];

            // Remove client from session
            session.clients = session.clients.filter(c => c.socket !== socket);

            // Notify remaining participants
            this._broadcast(session, 'participant-left', {
                userId: leaving_user.user.id,
                timestamp: Date.now()
            });

            // Cleanup if empty
            if (session.clients.length === 0) {
                setTimeout(() => {
                    if (session.clients.length === 0) {
                        this.sessions.delete(session.channelId);
                    }
                }, this.config.emptySessionTTL);
            }
        }
    }

    _getParticipantList(session) {
        return {
            master: session.master.user.id,
            clients: session.clients.map(c => c.user.id)
        };
    }

    /**
     * end web-socket implementaation 
     */

    /**
     * Loggin functionality
     * 
     * it is implemented as app.use for all requests
     */
    async logRequest(req, res, error = null) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            method: req.method,
            o_method: res.locals.overwriteMethod,
            path: req.path,
            user: req.user?.id || 'anonymous',
            key: req.params.key,
            status: error ? 500 : res.statusCode,
            error: error?.message
        };

        const logPath = path.join(
            this.config.data_root,
            'logs',
            `${moment().format('YYYY-MM-DD')}.log`
        );

        await fsp.appendFile(logPath, JSON.stringify(logEntry) + '\n');
    }
    /**
     * express implementation check the authentification
     */
    authMiddleware(req, res, next) {
        // Skip auth for login route
        if (req.path === '/auth/login') return next();

        /**
         * HMAC Authentication Implementation for io devices
         */
        if (this.accessData.hmac_auth_settings?.device_auth_enabled) {
            const deviceAuth = req.headers['x-device-auth'];
            if (deviceAuth) {
                return this.handleDeviceAuth(req, res, next);
            }
        }
        /* end HMAC implementation */

        // we have 2 token delivery methods: token in query and token in header.
        var token = null;
        const authHeader = req.headers.authorization;
        const authQuery = req.query.token;

        // tokens check
        /* if (authQuery && authHeader) {
            return res.status(401).json({ error: 'double authentication token in query string and header!' });
        } else */ 
         if (authHeader && !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Header carries valid "authorisation:" line, but missing the "Bearer " introduction!' });
        } else if (!authQuery && !authHeader) {
            return res.status(401).json({ error: 'No token available! Not in URL Query, nor in Header.' });
        }

        if (authQuery) {
            token = authQuery;
        } else if (authHeader) {
            // remove the 'Bearer ' part
            token = authHeader.split(' ')[1];;
        } else {
            return res.status(401).json({ error: 'Missing token query string "&token={token}" or in header "authoriziation: Bearer {token}"' });
        }

        try {
            const decoded = jwt.verify(token, this.config.jwt_secret);
            req.user = this.accessData.users[decoded.id];

            // A token can outlive the user it names: its signature stays valid for
            // the full hour, so removing someone from access.json does not revoke
            // what they already hold. Before reloadAccessData() that gap only
            // opened across a restart; now it opens the moment the file is
            // reloaded, which makes it worth closing properly.
            //
            // Without this the request continued with req.user undefined and died
            // later inside checkPermissions(), as a 500 that reads like a server
            // fault rather than a revoked account.
            if (!req.user) {
                return res.status(401).json({ error: 'Invalid authentication' });
            }

            // Sliding session: a JWT's expiry is baked into its signature, so it
            // can't be extended in place. Instead, every successful, authenticated
            // request re-issues a brand-new token with a fresh 1h expiry, carried
            // back in X-Renewed-Token (same payload shape as the login token, see
            // handleLogin()). The client must read this header and use it as the
            // bearer token for its next request; if it doesn't, the original token
            // simply expires at its original 1h mark as before - this only extends
            // the session for clients that actually pick up the renewed token.
            if (req.user) {
                const renewedToken = jwt.sign(
                    { id: req.user.id, groups: req.user.groups },
                    this.config.jwt_secret,
                    { expiresIn: '1h' }
                );
                res.set('X-Renewed-Token', renewedToken);
            }

            next();
        } catch (err) {
            res.status(401).json({ error: 'Invalid authentication' });
        }
    }

    getKeyPath(key) {
        const hash = crypto.createHash('sha256').update(key).digest('hex');
        const depth = this.config.index_depth;
        let pathParts = [];

        for (let i = 0; i < depth; i++) {
            pathParts.push(hash.substr(i * 2, 2));
        }

        return {
            hash,
            dir: path.join(this.config.data_root, 'data', ...pathParts),
            file: hash
        };
    }

    checkPermissions(user, key, operation) {
        const permIndex = { C: 0, R: 1, U: 2, D: 3, X: 4 };
        const idx = permIndex[operation];
        if (idx === undefined) return false;

        const userGroups = this.accessData.users[user.id].groups;
        let allowed = false;

        userGroups.forEach(group => {
            this.accessData.groups[group].rules.forEach(rule => {
                if (new RegExp(rule.regex).test(key)) {
                    var crudx = rule.crudx;
                    if (!crudx && rule.crud) {
                        // it is an old access.json format. in this case the excute was always allowed
                        crudx = rule.crud + '1';
                    }

                    if (crudx) {
                        allowed = crudx[idx] === '1';
                    }
                }
            });
        });

        return allowed;
    }

    /**
     * Union of every group's `allowed_origins` (access.json), forming the CORS
     * whitelist used in setupServer(). Optional per group, mirrors how
     * device.allowed_ips works for HMAC devices: a group with no allowed_origins
     * simply contributes nothing. Enforcement itself is global, not per-group -
     * see the comment above the cors() call for why it can't be scoped tighter.
     */
    getAllowedCorsOrigins() {
        const origins = new Set();
        for (const group of Object.values(this.accessData.groups || {})) {
            (group.allowed_origins || []).forEach(origin => origins.add(origin));
        }
        return origins;
    }

    /**
     * Whether a request carrying this Origin header may talk to the server at all.
     * Shared by the Express CORS middleware and socket.io's CORS block, so the two
     * can't drift apart.
     *
     * Two deliberate pass-throughs:
     * - empty whitelist: no group has opted in yet, so everything stays allowed,
     *   exactly as it behaved before allowed_origins existed.
     * - no Origin header: not a browser (curl, server-to-server, native client).
     *   Such clients ignore CORS anyway, so refusing them here would buy nothing
     *   while breaking legitimate integrations. Real protection is the JWT check.
     *
     * Careful with "null" - it is NOT one of those pass-throughs. A browser sends
     * the literal header `Origin: null` for a page opened straight off disk
     * (file://), for sandboxed iframes and for some redirect chains, and it arrives
     * here as the four-character string "null", not as a missing origin. It is
     * therefore matched against the whitelist like any other origin, on purpose:
     * "null" identifies no one, so any sandboxed iframe on any site could claim it.
     *
     * If a setup really has to allow it (local development against a file:// page),
     * allowed_origins needs the QUOTED string "null". A bare JSON null literal
     * silently matches nothing: it still counts toward the whitelist size, so the
     * open-by-default fallback does not kick in either, and every browser request
     * is refused with no hint as to why.
     */
    isOriginAllowed(origin) {
        const allowed = this.getAllowedCorsOrigins();
        return allowed.size === 0 || !origin || allowed.has(origin);
    }

    checkAdmin(user) {
        if (!user || !user.id) return false;

        // Get user's groups from access data
        const userEntry = this.accessData.users[user.id];
        if (!userEntry || !userEntry.groups) return false;

        // Consider both 'admin' and 'superadmin' as admin roles
        const adminGroups = new Set(['admin', 'superadmin']);

        // Group membership only, deliberately.
        //
        // This used to also return true for any group holding X on ANY rule, which
        // silently turned script execution into full admin: a group scoped to one
        // key prefix with crudx "11111" got /admin/keys, /admin/logs - seven days of
        // request history across every client, unfiltered - plus rebuild-index and
        // the newer rotate-index and reload-access. It needed no admin group and no
        // rule matching anything under /admin.
        //
        // Verified on a live install before removing it: the `worker` group grants X,
        // so its members were full admins without being in any admin group, and no
        // successful /admin/* call existed in the whole request history, so nothing
        // depended on the behaviour. Execute is a permission on keys; it is not a
        // role, which is what the CRUDX model promises by keeping X separate.
        return userEntry.groups.some(group => adminGroups.has(group));
    }

    async executeScript(req, code, context) {
        const engine = getScriptEngine(this.config.script_engine);
        const limits = {
            timeoutMs: parseInt(this.config.script_execution_time_limit) || 5000,
            memoryLimitBytes: 350 * 1024 * 1024 // 350MB
        };

        try {
            return await engine.run(code, context, limits);
        } catch (err) {
            if (err.code === 'TIMEOUT') {
                throw new Error('Script exceeded maximum execution time');
            } else {
                throw new Error(`Script failed: "${err.message}"`);
            }
        }
    }
    /**
     * Which of the large context values a script actually mentions.
     *
     * Conservative on purpose. A false positive only means injecting something the
     * script ignores, which is what always used to happen; a false negative would
     * hand the script `undefined` where it expected a document. So anything that
     * could reach a global without naming it - dynamic property access on
     * globalThis, eval, the Function constructor, with - opts out of the
     * optimisation entirely rather than being analysed.
     *
     * Word boundaries matter: `data.value` and `data =` both count, while
     * `metadata` and `mydata` do not.
     */
    scriptReferences(code) {
        const src = String(code || '');
        const dynamic = /\b(globalThis|eval|Function|with)\b/.test(src);
        const refers = (name) => dynamic || new RegExp(`\\b${name}\\b`).test(src);

        return {
            data: refers('data'),
            origin: refers('origin'),
            custom: refers('custom')
        };
    }

    // Add to handleKeyRequest body processing
    async processScriptBody(req, script, body, data) {
        if (script) {
            // Only what the script refers to is marshalled across the sandbox
            // boundary. `origin` is the whole stored record and `data` its value,
            // so a script that touches neither used to pay for the document twice
            // over: the context is serialized into a single JSON string, and for a
            // large document that was the difference between a few hundred bytes
            // and several hundred megabytes. Three production failures came out of
            // it - a sandbox out-of-memory, a V8 "Invalid string length" at 396MB,
            // and a script timeout - for writes that only attached metadata.
            //
            // Withholding a value breaks the round trip that the caller relies on:
            // every context value is handed back by the wrapper, which is how an
            // untouched `custom` survives a write and how `data = data` preserves a
            // document. So whatever is withheld is restored below, and the caller
            // cannot tell the difference.
            const needs = this.scriptReferences(script);

            const result = await this.executeScript(req, script, {
                origin: needs.origin ? data : undefined,
                custom: needs.custom ? (data ? data.custom : undefined) : undefined,
                body: body,
                data: needs.data ? (data ? data.value : undefined) : undefined,
                user: req.user.user,
                http_method: req.method,
                key: data ? data._key : undefined,
                hash: data ? data._hash : undefined,
                // Deliberately NOT seeded with null. The caller distinguishes
                // "the script never assigned response" from "the script set it to
                // null", and only undefined can carry the first meaning: an
                // untouched response stays undefined and JSON.stringify drops it
                // from the payload entirely, while an explicit null survives as
                // null. Seeding it with null made the two indistinguishable.
                response: undefined,

                // Left undefined for the same reason: only an unassigned abort can
                // mean "the script did not refuse". See resolveScriptAbort().
                abort: undefined
            });

            // Restore what was withheld. `origin` needs nothing: the wrapper never
            // returns it, so no caller can observe its absence.
            if (!needs.data) result.data = data ? data.value : undefined;
            if (!needs.custom) result.custom = data ? data.custom : undefined;

            return result;
        }
        return null;
    }

    /**
     * Turns a script's `abort` into an HTTP status and body, or null when the
     * script did not refuse.
     *
     * Why this exists: a script had no way to say "do not write". The wrapper
     * always returns `data`, so a script that set only an error on `response` still
     * handed back a storable document and the server wrote it - incrementing
     * `_modCounter` and appending to the index for an operation the script had
     * already rejected. A client reservation script doing exactly that is how one
     * production key reached 34245 modifications: every failed attempt wrote too,
     * and any client tracking that document's version saw it move for nothing.
     *
     * Accepted forms, in order of how specific they are:
     *   abort = true                          -> 412, generic message
     *   abort = "no slots left"               -> 412, that message
     *   abort = { status: 409, error: {...} }  -> that status and body
     *
     * The status is clamped to 400-599: a script must not be able to claim 2xx for
     * an operation that deliberately did not happen. 412 Precondition Failed is the
     * default, because refusing based on the current state is what this is for.
     */
    resolveScriptAbort(abort) {
        if (abort === undefined || abort === null || abort === false) return null;

        let status = 412;
        let error = { error: 'Operation aborted by script' };

        if (typeof abort === 'string') {
            error = { error: abort };
        } else if (typeof abort === 'object') {
            const candidate = Number(abort.status);
            if (Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) {
                status = candidate;
            }
            if (abort.error !== undefined) {
                error = typeof abort.error === 'string' ? { error: abort.error } : abort.error;
            }
        }

        return { status, error };
    }

    /**
     * Runs `fn` with exclusive access to one key, queueing behind anything already
     * running for that same key. Different keys never wait on each other.
     *
     * Needed because a write is not one operation but three: read the document,
     * run the script, write the result. Without serialization two requests both
     * read the same starting state and the second silently discards the first
     * one's result. Measured before this existed: three workers doing 40 writes
     * each on one key, 8 acknowledged as successful, none of them surviving.
     *
     * Scope and limits: this is an in-process queue, so it holds for one server
     * instance. Running several instances against the same data_root would need
     * real file locking instead. A rejected operation must not break the chain for
     * everyone queued behind it, hence the settle-either-way handling below.
     */
    async withKeyLock(key, fn) {
        const previous = this._keyLocks.get(key) || Promise.resolve();

        // Start only once the previous holder has settled, successfully or not.
        const run = previous.then(() => fn(), () => fn());
        // The queue tail must never reject, or the next waiter inherits the failure.
        const tail = run.then(() => { }, () => { });
        this._keyLocks.set(key, tail);

        try {
            return await run;
        } finally {
            // Drop the entry when nobody queued up behind us, so the map does not
            // grow by one permanent entry for every key ever written.
            if (this._keyLocks.get(key) === tail) this._keyLocks.delete(key);
        }
    }

    /**
     * Serializes anything that can modify a key, then hands off to the real handler.
     *
     * Reads deliberately skip the queue: writeKeyData() renames atomically, so a
     * reader always sees one complete document, and making reads wait would stall
     * them behind writes on exactly the hot keys that need throughput most.
     *
     * The effective method is what counts, since X-Method-Override rewrites it
     * further down: a POST flagged as GET is a read and must not take the lock,
     * while the reverse does modify and must.
     */
    async handleKeyRequest(req, res) {
        const effectiveMethod = (res.locals?.overwriteMethod || req.method || '').toUpperCase();
        const modifies = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(effectiveMethod);

        if (!modifies) return this._handleKeyRequest(req, res);
        return this.withKeyLock(req.params.key, () => this._handleKeyRequest(req, res));
    }

    async _handleKeyRequest(req, res) {
        try {
            let key = req.params.key;
            let generatedKey = undefined;
            const user = req.user;
            var response = {}; // here we will store the response, which might be modified through the existence of the script handling.
            response.options = {}; // http options like status ...
            response.modifiable_method = null;

            res.locals.original_method = req.method;
            if (res.locals.overwriteMethod) {
                req.method = res.locals.overwriteMethod;
            }

            if (["GET", "DELETE"].indexOf(req.method) > -1) {
                req.modifiable_method = false;
            } else {
                req.modifiable_method = true;
            }

            if (key.includes("*")) {

                // Handle wildcard key generation for POST requests
                if (req.method !== 'POST') {
                    return res.status(403).json({ error: 'Wildcard "*" only allowed for POST commandds!' });
                } else if (res.locals.overwriteMethod) {
                    return res.status(403).json({ error: 'Wildcard "*" only allowed for POST commandds! without "overwrite-Method" header' });
                } else {
                    generatedKey = await this.processWildcardKey(key);
                    if (generatedKey) {
                        key = generatedKey;
                        req.params.key = generatedKey; // Update request context
                    }
                }
            }

            // 1. Check key existence first
            const exists = this.index.has(key);
            if (req.method !== 'POST' && !exists) {
                return res.status(404).json({ error: 'Key not found' });
            }

            // 2. Enhanced permission checking
            const operation = this.mapMethodToOperation(req.method);
            if (!this.checkPermissions(user, key, operation)) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }

            // 3. parse the body request
            const parsed = this.parseScriptPayload(req.body);
            if (parsed.error) {
                throw new Error(parsed.error);
            }

            // 3. read the key data
            let data;
            if (exists) {
                data = await this.readKeyData(req, key);
            }

            // 3b. Conditional request handling. Deliberately here: inside the lock
            // and after the read, so the version compared against is the one the
            // write will actually land on. The ETag goes out on every response,
            // including the 412, so a client that loses the race learns the current
            // version without a second round trip.
            const currentEtag = exists ? this.etagFor(data) : null;
            if (currentEtag !== null) res.set('ETag', currentEtag);

            const precondition = this.evaluatePreconditions(req, currentEtag);
            if (precondition) {
                // A 304 must carry no body at all, so it cannot go out through
                // res.json() like the failures do.
                if (precondition.status === 304) return res.status(304).end();
                return res.status(precondition.status).json(precondition.error);
            }

            // 4. Handle JavaScript execution
            if (parsed.script) {
                // check, if excution is allowed
                if (!this.checkPermissions(req.user, key, 'X')) { // Execute permission check
                    return res.status(403).json({ error: 'Execution not allowed' });
                }
                response = await this.processScriptBody(req, parsed.script, parsed.body, data);
                // add the options to the response
                response.options = {};

                // These three checks ask "was it assigned", never "is it truthy".
                // Testing truthiness rejected scripts that legitimately produced 0,
                // false or an empty string, and on a write it treated an explicit
                // null as "unset" and sent the entire stored document back instead.
                // See processScriptBody(): response is left undefined precisely so
                // that undefined can mean "never assigned" here.

                // An abort is decided before anything else, because every branch
                // below produces a document to store. Setting options.error here is
                // what keeps the write from happening at all: the operation switch
                // further down runs only when options.error is unset.
                const aborted = this.resolveScriptAbort(response.abort);
                if (aborted) {
                    response.options.status = aborted.status;
                    response.options.error = aborted.error;
                    response.options.content = "json";
                } else if (req.modifiable_method) {
                    if (response.data === undefined) {
                        // a modifiable call needs to set the "data" variable in the script!
                        response.options.status = 400;
                        response.options.error = { error: 'script is a modifiable call, but misses to set the "data" value inside the script!' };
                        response.options.content = "json";
                    } else {
                        response.options.status = 200;
                        response.options.content = "json";
                        response.data = { ...data, value: response.data, custom: response.custom };
                        // if the response was never assigned, fall back to the stored value
                        if (response.response === undefined) {
                            response.response = response.data.value;
                        }
                    }
                } else if (!req.modifiable_method) {
                    // if the response.response was assigned, use it, whatever its value
                    if (response.response !== undefined) {
                        // do nothing :)
                        response.options.status = 200;
                        response.options.content = "json";
                    } else {
                        // there is no response, no data, so it makes no sense to run that script.
                        response.options.status = 403;
                        response.options.content = "json";
                        response.options.error = { error: "if this call doesn't make a modification to the 'response', and is a not modifiable call ('POST', 'PUT', ...), then it will not make a sense to call it anyway. Request blocked." };
                    }
                }
            } else {
                // it is just script free information.
                // if this is a file upload, then the response is never the data uploaded itself.
                if (res.locals.fileUpload) {
                    response.response = { ok: "upload successfull" };

                    // The existing record, or an empty object when the key is new.
                    //
                    // This used to be a placeholder string, on the reasoning that
                    // writeKeyData() fills in the file itself. But writeKeyData()
                    // decides new-versus-existing by looking for `_key` on what it is
                    // given, and a string has none - so every upload took the
                    // "brand new record" branch and reset `_modCounter` to 0,
                    // reset `_created`, and dropped `custom`.
                    //
                    // The version never advancing is what made conditional requests
                    // unusable for files: a browser holding ETag "0" was told 304 for
                    // every later version of the document, so a replaced PDF was
                    // served from cache indefinitely.
                    response.data = data || {};
                } else {
                    if (req.modifiable_method) {
                        // a modifiable request don't need a response.
                        // so it will overwrite the old data with the body
                        response.data = { ...data, value: parsed.body };
                        response.response = { ok: "successfull" };
                    } else {
                        // not modifiable requests need a response
                        response.data = data;
                        if (data) {
                            response.response = response.data.value;
                        }
                    }
                }
            }

            // 5. Handle core operations
            if (!response.options.error) switch (req.method) {
                case 'GET':
                    res.set({
                        'X-DeepJSON-ModCount': this.modificationCounter,
                        'X-DeepJSON-ReadCount': this.index.get(key)?.readCount || 0
                    });
                    response.options.status = 200;
                    response.options.content = "json";
                    break;
                //return res.json(response.response);

                case 'POST':
                    if (exists && !res.locals.overwriteExisting) {
                        response.options.status = 400;
                        response.options.error = { error: 'Key already exists (alternatively try "x-override-existing")' };
                    } else {
                        const tmp_data = response.data;
                        // The ETag of the version just written, so a client running
                        // a read-modify-write loop can chain its next If-Match
                        // without re-reading the document.
                        const written = await this.writeKeyData(req, res, key, tmp_data);
                        res.set('ETag', this.etagFor(written));
                        response.options.status = 201;
                        if (generatedKey) {
                            response.response = { ok: "success", key: generatedKey };
                        }
                    }
                    response.options.content = "json";
                    break;
                //return res.status(201).json(response.response);
                case 'PUT':
                    res.set('ETag', this.etagFor(await this.writeKeyData(req, res, key, response.data)));
                    response.options.status = 200;
                    response.options.content = "json";
                    break;
                //return res.json(response.response);

                case 'DELETE':
                    await this.deleteKeyData(req, key);
                    response.options.status = 204;
                    break;
                //return res.status(204).send();

                default:
                    response.options.status = 405;
                    response.options.error = { error: `Method not allowed: ${req.method}` };
                    response.options.content = "json";
                    break;
            }
            if (!response.options.status) {
                response.options.status = 500;
                response.options.error = { error: 'internal error: status not set' };
                response.options.content = "json";
            }
            if (!res.locals.binaryRequest) {
                res.status(response.options.status);

                const output = response.options.error ? response.options.error : response.response;

                if (response.options.content === "json") {
                    res.json(output);
                } else {
                    res.send(output);
                }
                return res;
            } else {
                res.status(response.options.status);
                return await this.handleFileResponse(response.data, res, req);
            }
        } catch (err) {
            await this.logRequest(req, res, err);
            const status = err.code === 'ENOENT' ? 404 : 500;
            return res.status(status).json({
                error: err.message,
                code: err.code
            });
        }
    }

    // Helper method to map HTTP methods to CRUDX operations
    mapMethodToOperation(method) {
        const map = {
            GET: 'R',
            POST: 'C',
            PUT: 'U',
            PATCH: 'U',
            DELETE: 'D',
            HEAD: 'R',
            OPTIONS: 'R'
        };
        return map[method] || 'R';
    }

    parseScriptPayload(body) {

        const result = {
            script: null,
            body: null,
            error: null
        };

        if (!body) {
            // no body existing
        } else {
            try {
                // throw errors, if it is the old format

                if (body.indexOf('javascript:get') === 0) {
                    // old get
                    throw new Error('Old "javsacript:get" start tag. it has to be plain "javascript:"');
                } else if (body.indexOf('javascript:set') === 0) {
                    // old get
                    throw new Error('Old "javsacript:set" start tag. it has to be plain "javascript:"');
                }

                // Check for javascript: operation at start
                var scriptStart = body.indexOf('javascript:');
                if (scriptStart === 0) {
                    const scriptEnd = body.lastIndexOf('javascript!');
                    if (scriptEnd === -1) {
                        throw new Error('Missing closing "javascript!" tag');
                    }

                    result.script = body.substring(scriptStart + 'javascript:'.length, scriptEnd).trim();
                    result.body = body.substring(scriptEnd + 'javascript!'.length).trim();
                    if (result.body.length === 0) {
                        result.body = null;
                    } else {
                        try {
                            result.body = JSON.parse(result.body);
                        } catch (err) {
                            throw new Error(`Invalid JSON data: ${err.message}`);
                        }
                    }
                } else {
                    // no opening tag
                    result.body = JSON.parse(body);
                }

            } catch (error) {
                return { ...result, error: error.message };
            }
        }
        return result;
    }

    setupAdminRoutes() {
        const router = express.Router();

        // Admin-only middleware
        router.use((req, res, next) => {
            if (!this.checkAdmin(req.user)) {
                return res.status(403).json({ error: 'Admin access required' });
            }
            next();
        });

        // Admin endpoints
        router.get('/keys', this.handleAdminKeys.bind(this));
        router.get('/health', this.handleAdminHealth.bind(this));
        router.get('/modifications/:since', this.handleAdminModCount.bind(this));

        // Add new endpoints
        router.post('/rebuild-index', async (req, res) => {
            await this.rebuildIndex();
            res.json({ status: 'success' });
        });

        // Compaction of the append-only index log. Separate from rebuild-index:
        // rebuild reconstructs the index by reading every data file on disk,
        // rotate only rewrites the log from the index already in memory.
        router.post('/rotate-index', async (req, res) => {
            const result = await this.performIndexRotation();
            res.json({ status: 'success', ...result });
        });

        // Re-read access_file without restarting. A rejected file is a 400 with the
        // specific problems, not a 500: the caller gave us a bad file, and the
        // server is still serving happily on the previous one.
        router.post('/reload-access', async (req, res) => {
            try {
                const result = await this.reloadAccessData();
                res.json({ status: 'success', ...result });
            } catch (err) {
                if (err.code === 'ACCESS_RELOAD_FAILED') {
                    return res.status(400).json({ error: err.message, problems: err.problems });
                }
                throw err;
            }
        });

        router.get('/logs', async (req, res) => {
            const logs = await this.getLogEntries();
            res.json(logs);
        });

        // Mount under /admin prefix
        this.app.use('/admin', router);
    }
    async getLogEntries(days = 7) {
        const logFiles = [];
        const now = moment();

        for (let i = 0; i < days; i++) {
            const date = now.clone().subtract(i, 'days');
            const logPath = path.join(
                this.config.data_root,
                'logs',
                `${date.format('YYYY-MM-DD')}.log`
            );

            if (await fsp.access(logPath).then(() => true).catch(() => false)) {
                logFiles.push(logPath);
            }
        }

        return Promise.all(logFiles.map(async file => {
            const content = await fsp.readFile(file, 'utf8');
            return content.split('\n').filter(l => l).map(JSON.parse);
        }));
    }

    /**
     * Path of the live index log that loadIndex()/updateIndex() append to,
     * and that performIndexRotation() rewrites with the compacted state.
     * Distinct from the dated archive snapshots written by saveIndexSnapshot().
     */
    getCurrentIndexPath() {
        return path.join(this.config.data_root, 'index', 'dj.index');
    }

    /**
     * Path of a dated archive snapshot (index/archive/dj.index.YYYYMMDD), kept
     * separate from the live index log so index/ itself doesn't accumulate one
     * file per rotation forever. See cleanupIndexArchive() for retention.
     */
    getIndexArchivePath(dateStr = moment().format('YYYYMMDD')) {
        return path.join(this.config.data_root, 'index', 'archive', `dj.index.${dateStr}`);
    }

    async loadIndex() {
        const indexPath = this.getCurrentIndexPath();

        try {
            // Check if index directory exists
            await fsp.access(path.dirname(indexPath), fs.constants.F_OK);
        } catch (dirError) {
            // Create index directory if missing
            await fsp.mkdir(path.dirname(indexPath), { recursive: true });
        }

        try {
            const data = await fsp.readFile(indexPath, 'utf8');
            let maxModCount = 0;

            data.split('\n').forEach(entry => {
                if (entry.trim()) {
                    const [key, hash, created, modified, modCount, operation] = entry.split('|');

                    // Handle DELETE operations
                    if (operation === 'DELETE') {
                        this.index.delete(key);
                        maxModCount++;
                    } else {
                        const count = parseInt(modCount) || 0;
                        this.index.set(key, {
                            hash,
                            created,
                            modified: modified || created,
                            modCount: count
                        });
                        maxModCount = Math.max(maxModCount, count);
                    }
                }
            });

            this.modificationCounter = maxModCount;
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('No existing index found. Starting fresh.');
                this.index = new Map();

                // Create initial empty index file
                await this.saveIndexSnapshot();
            } else {
                throw error;
            }
        }
    }

    // Add to existing updateIndex method
    async updateIndex(req, key, operation, existingEntry = null) {
        // Serialized against performIndexRotation() through INDEX_LOCK, so an
        // append can never interleave with the rewrite of the same file. This is a
        // different lock from the per-key one held by writeKeyData()/handleMove(),
        // and nothing holding INDEX_LOCK takes a per-key lock, so the two cannot
        // deadlock. Appends are a single appendFile, so the added contention is
        // negligible next to the document write that precedes them.
        await this.withKeyLock(INDEX_LOCK, () => this._updateIndex(req, key, operation, existingEntry));

        // Outside the lock on purpose - see fsyncIndexLog().
        await this.fsyncIndexLog();
    }

    async _updateIndex(req, key, operation, existingEntry = null) {
        const now = new Date().toISOString();
        var entry = this.index.get(key);

        if (operation === 'DELETE') {
            //logEntry = `${key}|${existingEntry?.hash || ''}|${existingEntry?.created || ''}|${now}|${existingEntry?.modCount || 0}|DELETE|${req.user?.id || 'system'}\n`;
            this.index.delete(key);
        } else {

            if (!entry) {
                entry = {
                    hash: this.getKeyPath(key).hash,
                    created: now,
                    modified: now,
                    modCount: 0
                };
            }

            entry.modified = now;
            entry.modCount = ++this.modificationCounter;

            this.index.set(key, entry);

        }
        // Append to daily index log
        const logEntry = `${key}|${entry.hash}|${entry.created}|${entry.modified}|${entry.modCount}|${operation}|${req.user?.id || 'system'}\n`;
        await fsp.appendFile(
            this.getCurrentIndexPath(),
            logEntry
        );
    }

    async rebuildIndex() {
        this.index = new Map();
        const dataDir = path.join(this.config.data_root, 'data');
        let maxModCount = 0;

        const traverse = async (dir) => {
            const entries = await fsp.readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await traverse(fullPath);
                } else {
                    const result = await this.readKeyFromFile(fullPath);
                    if (result) {
                        this.index.set(result.key, result.entry);
                        maxModCount = Math.max(maxModCount, result.entry.modCount);
                    }
                }
            }
        };

        await traverse(dataDir);
        // Keep the modification counter ahead of every modCount found on disk, so the
        // next write's ++this.modificationCounter can't collide with a rebuilt entry.
        this.modificationCounter = maxModCount;
        await this.saveIndexSnapshot();
    }

    /**
     * only used by rebuildIndex().
     * Reads a data file's own JSON content and extracts the key plus the same
     * {hash, created, modified, modCount} shape that updateIndex()/loadIndex()
     * store in this.index, so a rebuilt entry is indistinguishable from a normal one.
     * Returns null for anything that isn't a valid, key-bearing data file.
     */
    async readKeyFromFile(filePath) {
        try {
            const raw = await fsp.readFile(filePath, 'utf8');
            const data = JSON.parse(raw);
            if (!data._key) return null;

            return {
                key: data._key,
                entry: {
                    hash: data._hash,
                    created: data._created,
                    modified: data._modification || data._created,
                    modCount: data._modCounter || 0
                }
            };
        } catch {
            return null;
        }
    }

    /**
     * GET /version - deliberately tiny, so a client can use it as a frequent
     * heartbeat. Behind authMiddleware, so it answers three questions at once:
     * is the server up, is my token still valid, and what am I talking to.
     * The renewed token rides along in X-Renewed-Token like on any other request.
     */
    handleVersion(req, res) {
        res.json({ version: this.getServerVersion() });
    }

    /**
     * GET /whoami - who the caller is and what they may do.
     * Optional: ?keys=a,b,c resolves the effective permissions for those keys.
     *
     * About `rules`: these are returned for display and debugging only, never as
     * something a client should evaluate itself. checkPermissions() walks every
     * group and every rule in order and the LAST match wins, so a later rule with
     * a 0 revokes what an earlier one granted, and the same rules in a different
     * order produce a different answer. A client reimplementing the usual "any
     * matching rule grants it" would disagree with the server exactly where it
     * matters. Anything load-bearing goes through `permissions` below, which is
     * computed by the same checkPermissions() that enforces on every request.
     */
    handleWhoami(req, res) {
        const userEntry = this.accessData.users[req.user.id] || {};
        const groups = userEntry.groups || [];

        // Flattened in evaluation order, with the owning group attached, so the
        // listing mirrors what the server actually walks through.
        const rules = [];
        for (const groupName of groups) {
            const group = this.accessData.groups[groupName];
            for (const rule of (group?.rules || [])) {
                rules.push({ group: groupName, regex: rule.regex, crudx: rule.crudx ?? rule.crud });
            }
        }

        const payload = {
            version: this.getServerVersion(),
            authenticated: true,
            // Built field by field on purpose: the stored record also holds the
            // password hash, and spreading it would hand that to the client.
            user: { id: userEntry.id, email: userEntry.email },
            groups,
            isAdmin: this.checkAdmin(req.user),
            rules,
            rulesAreAdvisory: true
        };

        const requested = (req.query.keys || '').split(',').map(k => k.trim()).filter(Boolean);
        if (requested.length) {
            payload.permissions = {};
            for (const key of requested) {
                payload.permissions[key] = {
                    C: this.checkPermissions(req.user, key, 'C'),
                    R: this.checkPermissions(req.user, key, 'R'),
                    U: this.checkPermissions(req.user, key, 'U'),
                    D: this.checkPermissions(req.user, key, 'D'),
                    X: this.checkPermissions(req.user, key, 'X')
                };
            }
        }

        res.json(payload);
    }

    /**
     * admin functions
     */
    /**
     * Same listing as /cmd/keys/, behind the admin gate. Delegated rather than
     * duplicated so the filtering order, the bounds and the key_list_limit ceiling
     * cannot drift apart between the two routes - this one had its own copy that
     * was unbounded and checked permissions over the whole index.
     */
    handleAdminKeys(req, res) {
        return this.handleListKeys(req, res);
    }

    async handleAdminHealth(req, res) {
        res.json({
            uptime: process.uptime(),
            storage: await this.getStorageStats(),
            modifications: this.modificationCounter
        });
    }

    /**
     * Reports index size and disk usage of the data_root volume.
     */
    async getStorageStats() {
        const stats = { indexedKeys: this.index.size };
        try {
            const fsStats = await fsp.statfs(this.config.data_root);
            const totalBytes = fsStats.blocks * fsStats.bsize;
            const freeBytes = fsStats.bfree * fsStats.bsize;
            stats.disk = {
                totalBytes,
                freeBytes,
                usedBytes: totalBytes - freeBytes
            };
        } catch (error) {
            stats.disk = { error: error.message };
        }
        return stats;
    }

    handleAdminModCount(req, res) {
        const since = parseInt(req.params.since);
        const changes = Array.from(this.index.entries())
            .filter(([_, data]) => data.modCount > since)
            .map(([key, data]) => ({
                key,
                modCount: data.modCount,
                modified: data.modified,
                operation: data.operation
            }));

        res.json({
            latestModCount: this.modificationCounter,
            changes
        });
    }


    /**
     * shutdown
     */
    async shutdown() {
        try {
            if (this._indexRotationTimer) clearInterval(this._indexRotationTimer);
            // Save final index state
            await this.saveIndexSnapshot();
            console.log('Server shutdown complete');
        } catch (err) {
            console.error('Error during shutdown:', err);
        }
    }

    async saveIndexSnapshot() {
        const indexPath = this.getIndexArchivePath();

        // modCount is included even though loadIndex() never reads an archive:
        // without it a snapshot cannot stand in for the live index, because every
        // entry would come back as modCount 0 and reset the modification counter
        // that /admin/modifications/:since relies on.
        const entries = Array.from(this.index.entries())
            .map(([key, data]) => `${key}|${data.hash}|${data.created}|${data.modified}|${data.modCount}`);

        await fsp.writeFile(indexPath, entries.length ? `${entries.join('\n')}\n` : '');
    }

    /**
     * Compacts the append-only index log: archives the current state as a dated
     * snapshot, rewrites dj.index with one line per live key, then applies archive
     * retention.
     *
     * Compaction is what keeps the log bounded. Every write appends a line, so
     * without it the file grows forever and loadIndex() reads all of it at every
     * startup - a key written a thousand times costs a thousand lines, of which
     * only the last one matters. Rotating also drops DELETE tombstones, since a
     * key absent from the in-memory index needs no record at all.
     *
     * Runs under INDEX_LOCK for the whole operation, the snapshot of this.index
     * included, so no append can slip between reading the state and writing it.
     *
     * Returns what it did, so an operator calling this through the admin route can
     * see whether it was worth running.
     */
    async performIndexRotation() {
        return this.withKeyLock(INDEX_LOCK, () => this._performIndexRotation());
    }

    async _performIndexRotation() {
        const indexPath = this.getCurrentIndexPath();
        const bytesBefore = await fsp.stat(indexPath).then(s => s.size).catch(() => 0);

        // Archive current index into index/archive/
        await this.saveIndexSnapshot();

        // Start new index with current state
        const newEntries = Array.from(this.index.entries())
            .map(([key, data]) =>
                `${key}|${data.hash}|${data.created}|${data.modified}|${data.modCount}`
            );

        // Same temp-file-plus-rename as writeKeyData(), for the same reason: a
        // plain writeFile() truncates the live index first, so a crash midway
        // through leaves a partial index and the next startup comes up silently
        // missing keys. The temp file stays in the same directory to keep the
        // rename atomic instead of degrading into a copy.
        // The trailing newline is load-bearing: updateIndex() appends with
        // appendFile(), so without it the next append is glued onto the last
        // rotated line and loadIndex() parses the pair as one mangled entry,
        // losing the appended key entirely. An empty index writes an empty file
        // rather than a lone newline.
        const payload = newEntries.length ? `${newEntries.join('\n')}\n` : '';
        const tmpPath = path.join(
            path.dirname(indexPath),
            `.dj.index.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
        );
        try {
            await this.writeFileDurable(tmpPath, payload);
            await fsp.rename(tmpPath, indexPath);
            await this.fsyncDirectory(path.dirname(indexPath));
        } catch (writeError) {
            await fsp.unlink(tmpPath).catch(() => {});
            throw writeError;
        }

        // Enforce retention on the archive directory now that a new snapshot was added.
        const archivesRemoved = await this.cleanupIndexArchive();

        return {
            keys: this.index.size,
            bytesBefore,
            bytesAfter: Buffer.byteLength(payload),
            archive: this.getIndexArchivePath(),
            archivesRemoved
        };
    }

    /**
     * Enforces the retention policy on index/archive/, configured via
     * this.config.index_archiving = { older_than_days, archiving_url }.
     *
     * - older_than_days (number): IMPLEMENTED. Any archived snapshot file
     *   (index/archive/dj.index.YYYYMMDD) whose date, parsed from its filename,
     *   is more than this many days in the past is deleted.
     *
     * - archiving_url (string): NOT IMPLEMENTED. This is a placeholder for a
     *   future retention strategy delegated to an external service. The intended
     *   contract: for each archived snapshot file, this server would send an HTTP
     *   request to archiving_url carrying that file's content (e.g. as the request
     *   body of a POST), letting the remote endpoint inspect it (for example, to
     *   confirm it has already been copied to cold storage or long-term backup).
     *   The endpoint's response would then tell this server, per file, whether it
     *   is safe to delete or must be kept - so the external service owns the
     *   archival/retention decision instead of this server deciding on a fixed
     *   day count alone. Until this is implemented, archiving_url is ignored
     *   (only a warning is logged if it's set) and older_than_days is the only
     *   retention rule actually applied.
     */
    async cleanupIndexArchive() {
        const archivingConfig = this.config.index_archiving;
        if (!archivingConfig) return 0;

        if (archivingConfig.archiving_url) {
            console.warn(
                'index_archiving.archiving_url is configured but not implemented yet; ' +
                'only older_than_days retention is applied.'
            );
        }

        const olderThanDays = archivingConfig.older_than_days;
        if (!olderThanDays || olderThanDays <= 0) return 0;

        const archiveDir = path.join(this.config.data_root, 'index', 'archive');
        const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

        let files;
        try {
            files = await fsp.readdir(archiveDir);
        } catch (error) {
            if (error.code === 'ENOENT') return 0; // nothing archived yet
            throw error;
        }

        let removed = 0;
        for (const file of files) {
            const match = file.match(/^dj\.index\.(\d{4})(\d{2})(\d{2})$/);
            if (!match) continue; // ignore files that don't match the snapshot naming scheme

            const [, year, month, day] = match;
            const fileDate = Date.UTC(Number(year), Number(month) - 1, Number(day));

            if (fileDate < cutoff) {
                await fsp.unlink(path.join(archiveDir, file));
                removed++;
            }
        }
        return removed;
    }

    /**
     * logins
     */
    // Login handler
    async handleLogin(req, res) {
        try {
            const { username, password } = req.body;
            const user = this.authenticateUser(username, password);

            const token = jwt.sign(
                {
                    id: user.id,
                    groups: user.groups
                },
                this.config.jwt_secret,
                { expiresIn: '1h' }
            );

            res.json({
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    groups: user.groups
                }
            });
        } catch (error) {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    }
    // User authentication
    authenticateUser(username, password) {
        const user = this.accessData.users[username];

        if (!user || !this.verifyPassword(password, user.password)) {
            throw new Error('Invalid credentials');
        }

        return user;
    }

    /**
     * Hashes a plaintext password for storage in access.json.
     * Format: scrypt:<saltHex>:<hashHex>
     */
    hashPassword(password) {
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.scryptSync(password, salt, 64).toString('hex');
        return `scrypt:${salt}:${hash}`;
    }

    /**
     * Verifies a plaintext password against a scrypt hash produced by hashPassword().
     */
    verifyPassword(password, stored) {
        if (typeof stored !== 'string' || typeof password !== 'string') return false;

        const parts = stored.split(':');
        if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

        const [, salt, hashHex] = parts;
        const expected = Buffer.from(hashHex, 'hex');
        const actual = crypto.scryptSync(password, salt, expected.length);

        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }

    async readKeyData(req, key) {
        const { dir, file } = this.getKeyPath(key);
        const filePath = path.join(dir, file);

        try {
            const data = await fsp.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new Error(`Failed to read key from disk: ${error.code}`);
            }
            throw new Error(`Failed to read key: ${error.message}`);
        }
    }
    async writeKeyData(req, res, key, value) {
        const { dir, file } = this.getKeyPath(key);
        const filePath = path.join(dir, file);

        try {
            // Create directory structure if needed
            await fsp.mkdir(dir, { recursive: true });

            // Write data with metadata
            var data = {}

            if (value["_key"]) {
                //structure has already informations
                data = value;
                data._modification = new Date().toISOString();
                data._modCounter++;
                // from now on, just use the value of the value
                value = value.value;
            } else {
                // it's a new value. in this case, just add all the stuff to the value itself

                data = {
                    _key: key,
                    _hash: this.getKeyPath(key).hash,
                    _created: new Date().toISOString(),
                    _modification: null,
                    _modCounter: 0
                };
                data.value = value.value;
            }

            // if it is a file upload itself, then we have to assign the file to the object
            if (res.locals.fileUpload) {
                const upload = this.processFileUpload(req)
                Object.assign(data, upload);
            }

            // Write to a temp file, then rename over the target. rename(2) is atomic
            // on POSIX, so a concurrent reader always sees either the whole previous
            // document or the whole new one, never a half-written file.
            //
            // fsp.writeFile() on its own truncates the target and writes into it,
            // which had two failure modes under concurrency: a reader could catch
            // the file mid-write and fail to parse it, and a shorter write landing
            // on a longer one left the tail of the old content behind, corrupting
            // the document permanently.
            //
            // The temp file has to live in the same directory, so that the rename
            // stays within one filesystem and remains atomic instead of degrading
            // into a copy. The random suffix keeps two concurrent writers from
            // colliding on the temp file itself.
            const payload = JSON.stringify(data);
            const tmpPath = path.join(dir, `.${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
            try {
                await this.writeFileDurable(tmpPath, payload);
                await fsp.rename(tmpPath, filePath);
                await this.fsyncDirectory(dir);
            } catch (writeError) {
                // Never leave a stray temp file behind if the write or rename failed.
                await fsp.unlink(tmpPath).catch(() => {});
                throw writeError;
            }

            // Update index
            await this.updateIndex(req, key, 'WRITE');

            return data;
        } catch (error) {
            throw new Error(`Failed to write key: ${error.message}`);
        }
    }

    async deleteKeyData(req, key) {
        const { dir, file } = this.getKeyPath(key);
        const filePath = path.join(dir, file);

        try {
            // Delete data file
            await fsp.unlink(filePath);
        } catch (error) {
            if (error.code !== 'ENOENT') { // Ignore "not found" errors
                throw new Error(`Delete failed: ${error.message}`);
            }
        }

        // Remove from index and log
        const existingEntry = this.index.get(key);
        await this.updateIndex(req, key, 'DELETE', existingEntry);
        this.index.delete(key);

        // Remove empty directories
        await this.cleanupDirectories(dir);
    }

    async cleanupDirectories(dirPath) {
        let currentDir = path.dirname(dirPath);
        const rootDir = path.join(this.config.data_root, 'data');

        while (currentDir !== rootDir) {
            try {
                const files = await fsp.readdir(currentDir);
                if (files.length === 0) {
                    await fsp.rmdir(currentDir);
                }
                currentDir = path.dirname(currentDir);
            } catch (error) {
                break;
            }
        }
    }

    _hasaOverwriteMethod(req) {
        var returnvalue = null;
        if (req.headers['x-method-override']) {
            returnvalue = req.headers['x-method-override'].toUpperCase();
        }
        return returnvalue;
    }

    _isFileUpload(req) {
        if (req.headers['content-type']?.startsWith('multipart/form-data')) {
            return true;
        } else {
            return false;
        }
    }

    _isBinaryRequest(req) {
        if (req.query.binary !== undefined && req.query.binary !== null) {
            return true;
        } else {
            return false;
        }
    }

    _hasOverwriteExisting(req) {
        var returnvalue = null;
        if (req.headers['x-override-existing']) {
            return true;
        } else {
            return false;
        }
    }

    processFileUpload(req) {
        if (!req.files?.file) {
            throw new Error('No file uploaded');
        }

        

        const file = req.files.file;
        // latin to utf-8
        const utf_filename = Buffer.from(file.name, 'latin1').toString('utf8');
        const returnvalue = {
            _type: 'file',
            _meta: {
                filename: utf_filename,
                mimetype: file.mimetype,
                size: file.size,
                uploaded: new Date().toISOString(),
                hash: this.hashBase64Sha256(file.data),
                md5: file.md5
            },
            value: file.data.toString('base64')
        };
        return returnvalue;
    }

    /**
     * HMac authentication implementation functions
     * 
     * begin
     */
    async handleDeviceAuth(req, res, next) {
        try {
            const [deviceId, timestamp, user, signature] = req.headers['x-device-auth'].split(':');

            // Validate format
            if (!deviceId || !timestamp || !signature || !user) {
                throw new Error('Invalid auth header format: {deviceId}:{timestamp}:{user}:{signature}');
            }

            const timestampMs = parseInt(timestamp, 10);
            if (!Number.isFinite(timestampMs)) {
                throw new Error('Invalid timestamp');
            }

            // Check timestamp freshness
            const now = Date.now();
            if (Math.abs(now - timestampMs) > this.accessData.hmac_auth_settings.hmac_window * 1000) {
                throw new Error(`Timestamp out of window. Server time: ${new Date(now).toISOString()}, timestamp: ${timestampMs}`);
            }

            // Get device secret
            const device = this.accessData.devices[deviceId];
            if (!device?.enabled) throw new Error('Device not registered');
            if (!device?.user_list) throw new Error('Device is missing whitelist for users! ["user1", "user2", "user[0-9]{1,2}"]');

            // IP whitelisting
            if (device.allowed_ips && !this.checkIP(req.ip, device.allowed_ips)) {
                throw new Error('IP not allowed');
            }

            // user
            if (!this.accessData.users[user]) {
                throw new Error('Unknown user');
            }

            if (!this.checkUserList(device.user_list, user)) {
                throw new Error('User not in whitelist for the device!');
            }

            // Verify HMAC -- signed over the claimed identity (device + user) and the
            // request being authorized, so the signature can't be replayed to claim a
            // different user or a different request than the one it was issued for.
            const expectedSignature = crypto
                .createHmac('sha256', device.secret)
                .update(`${deviceId}|${user}|${req.method}|${req.path}|${timestamp}`)
                .digest('hex');

            const signatureBuffer = Buffer.from(signature);
            const expectedBuffer = Buffer.from(expectedSignature);
            const signatureValid = signatureBuffer.length === expectedBuffer.length
                && crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

            if (!signatureValid) {
                throw new Error('Invalid signature');
            }

            // if the HMAC authentication goes through, the add the user in to the request informations stack
            req.user = this.accessData.users[user];

            next();
        } catch (err) {
            res.status(401).json({ error: `Device auth failed: ${err.message}` });
        }
    }

    checkIP(ip, cidrList) {
        const ipaddr = require('ipaddr.js');
        const addr = ipaddr.parse(ip);
        return cidrList.some(cidr => {
            const range = ipaddr.parseCIDR(cidr);
            return addr.match(range);
        });
    }

    /**
     * runs the user against the user list to check, if the user is in whitelist
     */
    checkUserList(userList, user) {
        return userList.some((pattern) => new RegExp(`^${pattern}$`, 'i').test(user));
    }
    /* end HMAC implementation */

    /**
     * implementation of file response.
     * @param {i} fileData 
     * @param {*} res 
     * @param {*} req 
     * @returns 
     */
    async handleFileResponse(fileData, res, req) {
        try {
            const buffer = Buffer.from(fileData.value, 'base64');
            const contentType = fileData._meta.mimetype || '';

            const safeFilename = fileData._meta.filename || 'download.pdf';
            const disposition = contentDisposition(safeFilename, { type: 'inline' });

            // Prüfen, ob es ein Bild ist
            if (!this._isImage(contentType)) {
                // console.log("Not an image, sending raw file");
                res.set({
                    'Content-Type': contentType,
                    'Content-Length': buffer.length,
                    'Content-Disposition': disposition
                });
                return res.send(buffer);
            }

            const options = res?.locals?.image || {};

            let image = sharp(buffer)
                .rotate();  // Exit-Orientation digital cameras store pictures always landscape, but have a orientation flag. if you call rotate without any parameter, it will value the orientation and rotate to the right position

            if (options.width || options.height) {
                const fit = options.fit || 'contain'; // contain, cover, fill, inside, outside
                const withoutEnlargement = options.allowEnlarge === false;

                image = image.resize({
                    width: options.width,
                    height: options.height,
                    fit: fit,
                    withoutEnlargement: withoutEnlargement
                });

                // Alignment Mapping
                if (fit === 'cover' && (options.alignX || options.alignY)) {
                    const position = this._mapAlignment(options.alignX, options.alignY);
                    if (position) {
                        image = image.resize({
                            width: options.width,
                            height: options.height,
                            fit: 'cover',
                            position: position
                        });
                    }
                }
            }

            // Format Konvertierung wenn angegeben
            if (options.format) {
                if (options.format === 'jpeg' || options.format === 'jpg') {
                    image = image.jpeg({
                        quality: options.quality || 80 // optional Qualitätsparameter
                    });
                } else if (options.format === 'png') {
                    image = image.png({
                        compressionLevel: options.compressionLevel || 9
                    });
                }
            }

            const outputBuffer = await image.toBuffer();

            // Content-Type aktualisieren falls gewandelt
            const finalContentType = options.format === 'png' ? 'image/png'
                : options.format === 'jpeg' || options.format === 'jpg' ? 'image/jpeg'
                    : contentType;

            res.set({
                'Content-Type': finalContentType,
                'Content-Length': outputBuffer.length,
                'Content-Disposition': `inline; filename="${fileData._meta.filename}"`
            });

            res.send(outputBuffer);

        } catch (err) {
            console.error("Image processing error:", err);
            res.status(500).send("Failed to process image");
        }
    }

    // Hilfsfunktion zum Übersetzen von alignX / alignY zu Sharp-Positionen
    _mapAlignment(alignX, alignY) {
        // Sharp-Positionen: top, right top, right, right bottom, bottom, left bottom, left, left top, center
        const horizontal = {
            left: 'left',
            center: '',
            right: 'right'
        };
        const vertical = {
            top: 'top',
            center: '',
            bottom: 'bottom'
        };

        const h = horizontal[alignX] || '';
        const v = vertical[alignY] || '';

        if (h && v) return `${h} ${v}`.trim();
        if (h) return h;
        if (v) return v;
        return 'center'; // Default fallback
    }

    _isImage(contentType) {
        return /^image\/(jpeg|png|gif|bmp|webp|tiff|heic|heif)$/.test(contentType.toLowerCase());
    }

    _hasImageModulation(req) {
        const query = req.query || {};

        const width = query.width ? parseInt(query.width, 10) : undefined;
        const height = query.height ? parseInt(query.height, 10) : undefined;
        const fit = query.fit || undefined;  // z.B. 'cover', 'contain'
        const alignX = query.alignX || undefined; // 'left', 'center', 'right'
        const alignY = query.alignY || undefined; // 'top', 'center', 'bottom'
        const allowEnlarge = query.allowEnlarge !== undefined ? (query.allowEnlarge === 'true') : undefined;
        const format = query.format ? query.format.toLowerCase() : undefined; // 'jpeg' oder 'png'
        const quality = query.quality ? parseInt(query.quality, 10) : undefined;

        // Falls gar nichts gesetzt wurde, return undefined
        if (
            width === undefined &&
            height === undefined &&
            fit === undefined &&
            alignX === undefined &&
            alignY === undefined &&
            allowEnlarge === undefined &&
            format === undefined &&
            quality === undefined
        ) {
            return undefined;
        }

        // Setze nur die Felder die auch wirklich definiert sind
        const result = {};

        if (width !== undefined) result.width = width;
        if (height !== undefined) result.height = height;
        if (fit) result.fit = fit;
        if (alignX) result.alignX = alignX;
        if (alignY) result.alignY = alignY;
        if (allowEnlarge !== undefined) result.allowEnlarge = allowEnlarge;
        if (format) result.format = format;
        if (quality !== undefined) result.quality = quality;

        return result;
    }


    /**
     * end of impleentation of file resposne
     */

    /**
     * implementation wildcard key
     */
    async processWildcardKey(originalKey) {
        if (!originalKey.includes('*')) return null;

        const pattern = this.parseWildcardPattern(originalKey);
        if (!pattern) return null;

        return this.generateUniqueKey(pattern);
    }

    parseWildcardPattern(key) {
        const match = key.match(/\*\{\s*type\s*:\s*([a-z]+)\s*\}/);
        if (!match) return null;

        const fullMatch = match[0];
        const start = key.indexOf(fullMatch);
        const end = start + fullMatch.length;

        return {
            prefix: key.substring(0, start),
            type: match[1],
            suffix: key.substring(end)
        };

    }

    async generateUniqueKey(pattern) {
        let generated;
        let attempt = 0;

        do {
            switch (pattern.type) {
                case 'inc':
                    generated = await this.incrementalKey(pattern);
                    break;
                case 'random':
                    generated = this.randomKey(pattern);
                    break;
                default:
                    throw new Error('Invalid key generation type');
            }

            if (attempt++ > 100) {
                throw new Error('Failed to generate unique key');
            }
        } while (this.index.has(generated));

        return generated;
    }

    async incrementalKey(pattern) {
        const prefix = pattern.prefix; //.replace(/\.$/, '');
        const suffix = pattern.suffix; //.replace(/^\./, '');

        // Find highest existing sequence number
        let maxSeq = 0;
        const regex = new RegExp(`^${prefix}([0-9]+)${suffix}$`);

        for (const [key] of this.index) {
            const match = key.match(regex);
            if (match) {
                const seq = parseInt(match[1]);
                if (seq > maxSeq) maxSeq = seq;
            }
        }

        return `${prefix}${maxSeq + 1}${suffix}`;
    }

    randomKey(pattern) {
        const uuid = crypto.randomUUID().replace(/-/g, '');
        return `${pattern.prefix}${uuid}${pattern.suffix}`;
    }
    /**
     * end of implementation wildcard key
     */

    /**
     * Lists key NAMES, never document contents. This is the cheap query path: the
     * keyspace lives in memory, so a hierarchical naming scheme
     * ("de.client.site.type.id") is itself an index and a prefix pattern answers
     * most lookups without reading a single document.
     *
     * Three things matter for cost here, and all three used to be wrong:
     *
     * - The name filter runs BEFORE the permission check. checkPermissions() walks
     *   every group and every rule and compiles a regex per rule, per key, so it is
     *   by far the expensive half. Filtering names first means paying it only for
     *   the survivors: measured on a 11691-key index with 5 rules, 220ms became
     *   88ms for a prefix query, with identical results.
     * - The pattern is compiled once. Not for speed - V8 caches that - but so an
     *   unparseable pattern is a 400 naming the problem instead of an Express 500.
     * - The result can be limited. An unbounded listing returned 613KB for that
     *   same index, which is the opposite of what this server is for: the response
     *   should carry the answer, not the keyspace.
     */
    handleListKeys(req, res) {
        const source = req.method === 'POST' ? (req.body || {}) : req.query;
        const pattern = source.keys || undefined;
        const countOnly = source.count === true || source.count === 'true' || source.count === '1';

        // A bad number here is a client bug worth naming, not something to guess at.
        const asBound = (value, name) => {
            if (value === undefined || value === '') return undefined;
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0) {
                res.status(400).json({ error: `"${name}" must be a non-negative integer (got ${JSON.stringify(value)})` });
                return null;
            }
            return n;
        };

        const offset = asBound(source.offset, 'offset');
        if (offset === null) return;
        let limit = asBound(source.limit, 'limit');
        if (limit === null) return;

        // An operator-set ceiling, so one client cannot ask for the whole keyspace.
        // Unset means unlimited, which is how this endpoint has always behaved.
        const maxLimit = Number(this.config.key_list_limit) || undefined;
        if (maxLimit !== undefined) limit = limit === undefined ? maxLimit : Math.min(limit, maxLimit);

        let matcher;
        if (pattern) {
            try {
                matcher = new RegExp(pattern);
            } catch (err) {
                return res.status(400).json({ error: `"keys" is not a valid regular expression: ${err.message}` });
            }
        }

        let keys = Array.from(this.index.keys());
        if (matcher) keys = keys.filter(key => matcher.test(key));
        keys = keys.filter(key => this.checkPermissions(req.user, key, 'R'));

        const total = keys.length;
        if (countOnly) return res.json({ total });

        const start = offset || 0;
        const page = limit === undefined ? keys.slice(start) : keys.slice(start, start + limit);

        const payload = { total, keys: page };
        if (start > 0 || limit !== undefined) {
            payload.offset = start;
            if (limit !== undefined) payload.limit = limit;
            payload.truncated = start + page.length < total;
        }
        res.json(payload);
    }

    /**
     * begin MOVE implementation
     */

    // Enhanced handleMove implementation
    async handleMove(req, res) {
        try {

            // 1. Universal body parsing
            let body;
            try {
                body = await this.parseMoveBody(req);

                if (!body.from || !body.to) {
                    return res.status(400).json({
                        error: 'Missing parameters',
                        required: ['from', 'to'],
                        received: Object.keys(body)
                    });
                }
            } catch (parseError) {
                return res.status(400).json({
                    error: 'Invalid request body',
                    details: parseError.message,
                    supportedFormats: [
                        'application/json',
                        'text/plain (JSON string)',
                        'application/x-www-form-urlencoded'
                    ]
                });
            }

            const { from, to: rawTo } = body;

            // 1. Validate parameters
            if (!from || !rawTo) {
                return res.status(400).json({ error: 'Missing "from" or "to" in request body' });
            }

            // 2. Process wildcard in destination
            let to = rawTo;
            if (rawTo.includes('*')) {
                try {
                    to = await this.processWildcardKey(rawTo);
                    if (!to) throw new Error('Failed to generate destination key from wildcard');
                } catch (error) {
                    return res.status(400).json({
                        error: `Invalid destination wildcard: ${error.message}`
                    });
                }
            }

            // 3. Check source existence
            if (!this.index.has(from)) {
                return res.status(404).json({ error: `Source key "${from}" not found` });
            }

            // 4. Check target existence
            const toExists = this.index.has(to);
            if (toExists && !this._hasOverwriteExisting(req)) {
                return res.status(400).json({
                    error: `Target key "${to}" exists (use x-override-existing header)`,
                    generatedKey: to // Return the actual generated key
                });
            }

            // 5. Permission checks
            // Delete permission on source
            if (!this.checkPermissions(req.user, from, 'D')) {
                return res.status(403).json({ error: 'Insufficient permissions to delete source' });
            }

            // Create/Update permission on target
            const requiredToPerm = toExists ? 'U' : 'C';
            if (!this.checkPermissions(req.user, to, requiredToPerm)) {
                return res.status(403).json({
                    error: `Insufficient permissions to ${toExists ? 'update' : 'create'} target`,
                    requiredPermission: requiredToPerm,
                    targetKey: to
                });
            }

            // 6. Perform move operation
            const data = await this.readKeyData(req, from);

            // 7. change key name
            if( data && data._key ) {
                data._key = to;
                if( !data._meta._key_history ) data._meta._key_history = [];
                data._meta._key_history.push( { date: Date.now(), user: req.user.id, from: from, to: to });
            }

            await this.writeKeyData(req, res, to, data);
            await this.deleteKeyData(req, from);

            res.json({
                success: true,
                message: `Moved "${from}" to "${to}"`,
                details: {
                    from,
                    to,
                    generated: rawTo !== to, // Indicates if wildcard was resolved
                    targetExisted: toExists
                }
            });

        } catch (error) {
            await this.logRequest(req, res, error);
            res.status(500).json({
                error: error.message,
                code: error.code,
                stack: this.config.debug ? error.stack : undefined
            });
        }
    }
    // Add new helper method to the class
    async parseMoveBody(req) {
        // Case 1: Already parsed JSON body (express.json() middleware)
        if (_.isObject(req.body) && !Buffer.isBuffer(req.body)) {
            return req.body;
        }

        // Case 2: Text-based body
        const contentType = req.headers['content-type'] || 'text/plain';
        const rawBody = req.body.toString('utf8');

        try {
            // Handle different content types
            if (contentType === 'application/json' || contentType === 'text/plain') {
                return JSON.parse(rawBody);
            }

            if (contentType === 'application/x-www-form-urlencoded') {
                const parsed = {};
                for (const [key, value] of new URLSearchParams(rawBody).entries()) {
                    parsed[key] = value;
                }
                return parsed;
            }

            throw new Error(`Unsupported Content-Type: ${contentType}`);
        } catch (error) {
            throw new Error(`Body parsing failed: ${error.message}`);
        }
    }
    /**
     * end MOVE implementation
     */

    /**
     * Hashes a base64 string using SHA-256 (fallback for BLAKE3)
     * @param {string} base64 - The base64-encoded input
     * @returns {string} hex hash
     */
    hashBase64Sha256(base64) {
        const buffer = Buffer.from(base64, 'base64'); // decode base64 to raw bytes
        const hasher = crypto.createHash('sha256');
        hasher.update(buffer);
        return hasher.digest('hex');
    }
}

module.exports = DeepJSONServer;