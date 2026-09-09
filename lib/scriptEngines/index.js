// Factory for the script sandbox engine. Selected via dj.config's
// `script_engine` field (server-operator controlled, never client-facing --
// letting a request choose its own engine would let a caller pick whichever
// one has weaker isolation). Defaults to "wasm" (quickjs-emscripten), which
// has no native-build dependency and is safe to ship as a hard dependency.
//
// A "v8" engine (e.g. isolated-vm) is intentionally not wired up yet. It was
// evaluated and rejected for now: creating a V8 isolate segfaulted immediately
// in the environment it was tested in (Node 20.19.1 / macOS arm64), which
// looked like a prebuilt-binary/Node-ABI mismatch rather than a code issue --
// but that couldn't be verified further at the time, so nothing built on it
// should be trusted without testing it fresh in the target deployment
// environment first. quickjs-emscripten (pure WASM, no native binary) doesn't
// have this class of problem, which is part of why it's the default.

const engineCache = {};

function getScriptEngine(name = 'wasm') {
    if (!engineCache[name]) {
        switch (name) {
            case 'wasm':
                engineCache[name] = require('./quickjs');
                break;
            default:
                throw new Error(`Unknown script_engine "${name}". Valid options: "wasm".`);
        }
    }
    return engineCache[name];
}

module.exports = { getScriptEngine };
