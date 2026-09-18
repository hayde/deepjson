#!/usr/bin/env node
//
// Client-side test battery for the DeepJSON QuickJS script sandbox.
//
// Exercises the sandbox the way a real client does: over HTTP, with the
// `javascript: ... javascript!` payload format, as a user that actually holds
// the execute permission (crudx position 5).
//
// What it checks, in order:
//   A  the scripting contract  - which context variables arrive, what has to be
//                                set for a write vs. a read script
//   B  sandbox isolation       - that no Node globals leak into the guest
//   C  resource limits         - timeout and memory ceiling actually bite
//   D  semantic traps          - the ways a script silently produces nothing
//   E  error reporting         - syntax and runtime errors come back usable
//
// Usage:
//   node test-quickjs.js
//   DEEPJSON_URL=http://localhost:8787 DEEPJSON_USER=admin DEEPJSON_PASS=admin-pw node test-quickjs.js
//
// Requires Node 18+ (uses the built-in fetch). No dependencies.

const BASE = process.env.DEEPJSON_URL || 'http://localhost:8787';
const USER = process.env.DEEPJSON_USER || 'admin';
const PASS = process.env.DEEPJSON_PASS || 'admin-pw';

const RUN = `qjs${Date.now().toString(36)}`;
let token = null;
let keyCounter = 0;

/* ------------------------------------------------------------------ */
/* plumbing                                                            */
/* ------------------------------------------------------------------ */

const C = process.stdout.isTTY
    ? { ok: '\x1b[32m', bad: '\x1b[31m', dim: '\x1b[90m', head: '\x1b[1m', off: '\x1b[0m' }
    : { ok: '', bad: '', dim: '', head: '', off: '' };

async function login() {
    const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: USER, password: PASS })
    });
    if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`);
    const json = await res.json();
    if (!json.token) throw new Error(`login returned no token: ${JSON.stringify(json)}`);
    return json.token;
}

/**
 * Sends one script to the server.
 *
 * `read: true` sends the request as POST but flags it X-Method-Override: GET, so
 * the server treats it as a non-modifying call. That is the only practical way to
 * ship a read script, since a GET carrying a body is awkward for most clients.
 * A write script must assign `data`; a read script must assign `response`.
 */
async function runScript(code, { read = false, body = '', key = null, override = false } = {}) {
    const target = key || `${RUN}.k${++keyCounter}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain'
    };
    if (read) headers['X-Method-Override'] = 'GET';
    // Writing over an existing key is refused unless this is set.
    if (override) headers['X-Override-Existing'] = 'true';

    const res = await fetch(`${BASE}/keys/${encodeURIComponent(target)}`, {
        method: 'POST',
        headers,
        body: `javascript: ${code} javascript!${body}`
    });

    const raw = await res.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    return { status: res.status, body: parsed, raw, key: target };
}

/** Writes a plain value without any script, so read tests have something to read. */
async function seed(key, value) {
    const res = await fetch(`${BASE}/keys/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: JSON.stringify(value)
    });
    if (!res.ok) throw new Error(`seed(${key}) failed: HTTP ${res.status} ${await res.text()}`);
    return key;
}

const tests = [];
const group = (name) => tests.push({ group: name });
const test = (name, fn) => tests.push({ name, fn });
/** A test that asserts correct behavior the server does not currently show. */
const knownIssue = (name, fn) => tests.push({ name, fn, known: true });

/** Server error text, unescaped - matching the raw JSON would trip over \" quoting. */
const errorText = (r) => (r.body && r.body.error) || r.raw;

/* ------------------------------------------------------------------ */
/* A - the scripting contract                                          */
/* ------------------------------------------------------------------ */

group('A  Scripting-Vertrag');

test('write script: assigning `data` stores the value', async () => {
    const r = await runScript('data = { sum: 20 + 22, from: "quickjs" };');
    assert(r.status === 201 || r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 120)}`);
    assertDeep(r.body, { sum: 42, from: 'quickjs' });
});

test('write script without `data` is refused with a usable message', async () => {
    const r = await runScript('var ignored = 1;');
    assert(r.status === 400, `expected 400, got ${r.status}`);
    assert(/misses to set the "data" value/.test(errorText(r)), `unexpected message: ${errorText(r).slice(0, 160)}`);
});

test('read script: assigning `response` returns it without touching stored data', async () => {
    const key = await seed(`${RUN}.readable`, { preis: 100 });
    const r = await runScript('response = { doppelt: data.preis * 2 };', { read: true, key });
    assert(r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 160)}`);
    assertDeep(r.body, { doppelt: 200 });

    const after = await fetch(`${BASE}/keys/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    assertDeep(await after.json(), { preis: 100 });
});

test('read script without `response` is refused', async () => {
    const key = await seed(`${RUN}.readable2`, { a: 1 });
    const r = await runScript('var x = data.a;', { read: true, key });
    assert(r.status === 403, `expected 403, got ${r.status}`);
    assert(/will not make a sense/.test(errorText(r)), `unexpected message: ${errorText(r).slice(0, 160)}`);
});

test('context exposes key, hash, user, http_method, body and data', async () => {
    const key = await seed(`${RUN}.context`, { gespeichert: true });
    const r = await runScript(
        'response = { key: key, hasHash: typeof hash === "string" && hash.length === 64,' +
        ' user: typeof user, method: http_method, body: body, data: data,' +
        ' originKeys: Object.keys(origin).sort() };',
        { read: true, key, body: '{"mitgeschickt":7}' }
    );
    assert(r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
    assert(r.body.key === key, `key was ${JSON.stringify(r.body.key)}`);
    assert(r.body.hasHash === true, 'hash is not a 64-char string');
    assert(r.body.method === 'GET', `http_method was ${r.body.method} (override applied?)`);
    assertDeep(r.body.data, { gespeichert: true });
    assertDeep(r.body.body, { mitgeschickt: 7 });
    console.log(`      ${C.dim}origin enthält: ${r.body.originKeys.join(', ')}${C.off}`);
});

test('`custom` survives when it is set on an existing key', async () => {
    const key = await seed(`${RUN}.custom`, { v: 0 });
    const w = await runScript('data = { v: 1 }; custom = { markierung: "abc" };', { key, override: true });
    assert(w.status === 201 || w.status === 200, `write HTTP ${w.status}: ${w.raw.slice(0, 160)}`);
    const r = await runScript('response = { custom: custom };', { read: true, key });
    assertDeep(r.body.custom, { markierung: 'abc' });
});

knownIssue('`custom` is DROPPED when the script creates the key (server defect)', async () => {
    // writeKeyData() builds a fresh record for a key that does not exist yet and
    // only carries over _key/_hash/_created/_modification/_modCounter/value, so
    // `custom` set by the creating script is silently discarded. Setting it on a
    // key that already exists works, which is what makes this easy to miss.
    const w = await runScript('data = { v: 1 }; custom = { markierung: "neu" };');
    assert(w.status === 201 || w.status === 200, `write HTTP ${w.status}`);
    const r = await runScript('response = { custom: custom };', { read: true, key: w.key });
    assertDeep(r.body.custom, { markierung: 'neu' });
});

/* ------------------------------------------------------------------ */
/* B - sandbox isolation                                               */
/* ------------------------------------------------------------------ */

group('B  Sandbox-Isolation');

test('no Node globals leak in (process, require, fs, fetch, ...)', async () => {
    const key = await seed(`${RUN}.iso`, { x: 1 });
    const r = await runScript(
        'var namen = ["process","require","module","exports","global","globalThis.Buffer",' +
        '"fetch","XMLHttpRequest","setTimeout","setInterval","eval","Function"];' +
        'var gefunden = {};' +
        'namen.forEach(function(n){ try { gefunden[n] = typeof eval(n); } catch(e) { gefunden[n] = "nicht vorhanden"; } });' +
        'response = gefunden;',
        { read: true, key }
    );
    assert(r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
    for (const verboten of ['process', 'require', 'module', 'fetch', 'XMLHttpRequest']) {
        const typ = r.body[verboten];
        assert(typ === 'undefined' || typ === 'nicht vorhanden',
            `${verboten} ist im Gast erreichbar (typeof = ${typ})`);
    }
    console.log(`      ${C.dim}${Object.entries(r.body).map(([k, v]) => `${k}=${v}`).join('  ')}${C.off}`);
});

test('the guest cannot see the host filesystem through any global', async () => {
    const key = await seed(`${RUN}.iso2`, { x: 1 });
    const r = await runScript(
        'var alle = Object.getOwnPropertyNames(globalThis).sort();' +
        'response = { globals: alle, anzahl: alle.length };',
        { read: true, key }
    );
    assert(r.status === 200, `HTTP ${r.status}`);
    const verdaechtig = r.body.globals.filter(g => /^(process|require|fs|child_process|Deno|Bun)$/.test(g));
    assert(verdaechtig.length === 0, `verdächtige Globals: ${verdaechtig.join(', ')}`);
    console.log(`      ${C.dim}${r.body.anzahl} Globals, u.a.: ${r.body.globals.slice(0, 12).join(', ')}${C.off}`);
});

/* ------------------------------------------------------------------ */
/* C - resource limits                                                 */
/* ------------------------------------------------------------------ */

group('C  Ressourcengrenzen');

test('an endless loop is cut off by the execution time limit', async () => {
    const started = Date.now();
    const r = await runScript('while (true) {} data = { nie: true };');
    const dauer = Date.now() - started;
    assert(r.status >= 400, `expected an error status, got ${r.status}`);
    assert(/exceeded maximum execution time|interrupted|timeout/i.test(r.raw),
        `unexpected message: ${r.raw.slice(0, 200)}`);
    console.log(`      ${C.dim}abgebrochen nach ${dauer} ms${C.off}`);
});

test('runaway allocation hits the memory ceiling instead of the host', async () => {
    const r = await runScript(
        'var fresser = []; while (true) { fresser.push(new Array(100000).join("x")); } data = { nie: true };'
    );
    assert(r.status >= 400, `expected an error status, got ${r.status}`);
    assert(/memory|exceeded maximum execution time|interrupted/i.test(r.raw),
        `unexpected message: ${r.raw.slice(0, 200)}`);
    console.log(`      ${C.dim}Antwort: ${(r.body?.error || r.raw).toString().slice(0, 80)}${C.off}`);
});

/* ------------------------------------------------------------------ */
/* D - semantic traps                                                  */
/* ------------------------------------------------------------------ */

group('D  Semantische Fallen');

test('`return` does NOT produce the result - only assignment does', async () => {
    // The user code runs inside an IIFE whose return value is thrown away; the
    // wrapper reads the outer `data` / `response` / `custom` variables afterwards.
    const r = await runScript('return { gibt: "es nicht" };');
    assert(r.status === 400, `expected 400 (data never set), got ${r.status}`);
    assert(/misses to set the "data" value/.test(errorText(r)), `unexpected message: ${errorText(r).slice(0, 160)}`);
});

test('redeclaring `data` with let/var shadows it and loses the result', async () => {
    const r = await runScript('let data = { verloren: true };');
    assert(r.status === 400, `expected 400, got ${r.status}: ${r.raw.slice(0, 160)}`);
});

test('the boundary is JSON - functions, undefined and Dates do not survive intact', async () => {
    const key = await seed(`${RUN}.json`, { x: 1 });
    const r = await runScript(
        'response = { fn: function(){}, undef: undefined, datum: new Date(0),' +
        ' menge: new Set([1,2]), abbildung: new Map([["a",1]]), zahl: NaN, unendlich: Infinity };',
        { read: true, key }
    );
    assert(r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
    assert(!('fn' in r.body), 'Funktionen sollten wegfallen');
    assert(!('undef' in r.body), 'undefined sollte wegfallen');
    assert(typeof r.body.datum === 'string', `Date wurde zu ${typeof r.body.datum}`);
    assertDeep(r.body.menge, {});
    assert(r.body.zahl === null && r.body.unendlich === null, 'NaN/Infinity sollten null werden');
    console.log(`      ${C.dim}${JSON.stringify(r.body)}${C.off}`);
});

test('strict mode is active - assigning to an undeclared name throws', async () => {
    const r = await runScript('nichtDeklariert = 5; data = { x: 1 };');
    assert(r.status >= 400, `expected an error, got ${r.status}`);
    assert(/not defined|nichtDeklariert/i.test(r.raw), `unexpected message: ${r.raw.slice(0, 160)}`);
});

/* ------------------------------------------------------------------ */
/* E - error reporting                                                 */
/* ------------------------------------------------------------------ */

group('E  Fehlerbehandlung');

test('a syntax error is reported, not swallowed', async () => {
    const r = await runScript('data = { kaputt: ;');
    assert(r.status >= 400, `expected an error status, got ${r.status}`);
    assert(/(syntax|unexpected)/i.test(r.raw), `unexpected message: ${r.raw.slice(0, 160)}`);
});

test('a thrown error carries its message back to the client', async () => {
    const r = await runScript('throw new Error("fachlicher Abbruch 4711"); ');
    assert(r.status >= 400, `expected an error status, got ${r.status}`);
    assert(/4711/.test(r.raw), `message did not survive: ${r.raw.slice(0, 160)}`);
});

test('one failing script does not poison the next one', async () => {
    await runScript('throw new Error("kaputt");');
    const r = await runScript('data = { danach: "laeuft weiter" };');
    assert(r.status === 201 || r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 160)}`);
    assertDeep(r.body, { danach: 'laeuft weiter' });
});

/* ------------------------------------------------------------------ */
/* assertions + runner                                                 */
/* ------------------------------------------------------------------ */

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}
function assertDeep(actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) throw new Error(`erwartet ${e}, bekommen ${a}`);
}

(async () => {
    console.log(`${C.head}QuickJS-Sandbox-Test gegen ${BASE}${C.off}`);
    try {
        token = await login();
        console.log(`${C.dim}angemeldet als ${USER}, Testlauf-Präfix ${RUN}${C.off}\n`);
    } catch (err) {
        console.error(`${C.bad}Login fehlgeschlagen:${C.off} ${err.message}`);
        console.error(`${C.dim}Läuft der Server? Hat ${USER} Execute-Recht (crudx-Stelle 5)?${C.off}`);
        process.exit(1);
    }

    let pass = 0, fail = 0, known = 0;
    for (const entry of tests) {
        if (entry.group) { console.log(`${C.head}${entry.group}${C.off}`); continue; }
        try {
            await entry.fn();
            if (entry.known) {
                console.log(`  ${C.ok}bestanden${C.off}  ${entry.name}`);
                console.log(`      ${C.dim}bekannter Defekt ist offenbar behoben - Markierung entfernen${C.off}`);
            } else {
                console.log(`  ${C.ok}bestanden${C.off}  ${entry.name}`);
            }
            pass++;
        } catch (err) {
            if (entry.known) {
                console.log(`  ${C.dim}BEKANNT  ${C.off}  ${entry.name}`);
                console.log(`      ${C.dim}${err.message}${C.off}`);
                known++;
            } else {
                console.log(`  ${C.bad}FEHLER   ${C.off}  ${entry.name}`);
                console.log(`      ${C.bad}${err.message}${C.off}`);
                fail++;
            }
        }
    }

    console.log(`\n${C.head}${pass} bestanden, ${fail} fehlgeschlagen, ${known} bekannte Defekte${C.off}`);
    process.exit(fail ? 1 : 0);
})();
