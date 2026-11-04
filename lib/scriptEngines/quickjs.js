// Default script sandbox: QuickJS compiled to WebAssembly.
//
// Runs entirely inside WASM linear memory, so even a bug in the JS engine
// itself can't reach into the host Node process the way vm2's escapes did --
// and unlike vm2, it ships with no Node globals (process/require/fs/fetch)
// at all by default, so there's nothing to remember to null out.
//
// Context is passed across the boundary as a single JSON string rather than
// marshaling a live object graph -- executeScript()'s context is always
// plain JSON-safe data (see server.js), so this keeps the boundary simple
// and auditable: nothing but a string crosses in, nothing but a string
// crosses back out.

const { getQuickJS, shouldInterruptAfterDeadline } = require('quickjs-emscripten');

let quickJsModulePromise = null;
function loadQuickJS() {
    if (!quickJsModulePromise) quickJsModulePromise = getQuickJS();
    return quickJsModulePromise;
}

function wrapCode(code) {
    // `abort` is how a script refuses the operation. It has to cross back out
    // alongside data/custom/response, because the server cannot otherwise tell
    // "the script decided not to write" from "the script wrote the same value":
    // the wrapper always returns `data`, so a script that only sets an error on
    // `response` still produces a perfectly valid document to store.
    return `"use strict";
var { origin, custom, body, data, user, http_method, key, hash, response, abort } = JSON.parse(__CONTEXT__);
(function() {
${code}
})();
JSON.stringify({ response: response, data: data, custom: custom, abort: abort });`;
}

// Lines wrapCode() puts before the user's code, derived so it can't drift.
const WRAPPER_HEAD_LINES = wrapCode('@@').split('\n').indexOf('@@');

// Position of the first stack frame in the user's script, or null when it
// falls in the wrapper (or there is no stack).
function userPosition(info, code) {
    const m = /eval\.js:(\d+):(\d+)/.exec(info?.stack || '');
    if (!m) return null;
    const line = Number(m[1]) - WRAPPER_HEAD_LINES;
    if (line < 1 || line > code.split('\n').length) return null;
    return { line, column: Number(m[2]) };
}

function toEngineError(info, code) {
    const message = (info && info.message) || 'Unknown script error';

    if (info?.name === 'InternalError' && message === 'interrupted') {
        const err = new Error(message);
        err.code = 'TIMEOUT';
        return err;
    }
    if (info?.name === 'InternalError' && message === 'out of memory') {
        const err = new Error(message);
        err.code = 'MEMORY';
        return err;
    }
    const err = new Error(message);
    if (info?.name) err.name = info.name;
    Object.assign(err, userPosition(info, code));
    return err;
}

async function run(code, context, { timeoutMs, memoryLimitBytes }) {
    const QuickJS = await loadQuickJS();
    const runtime = QuickJS.newRuntime();

    try {
        runtime.setMemoryLimit(memoryLimitBytes);
        runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));

        const vm = runtime.newContext();
        try {
            const contextHandle = vm.newString(JSON.stringify(context));
            vm.setProp(vm.global, '__CONTEXT__', contextHandle);
            contextHandle.dispose();

            const result = vm.evalCode(wrapCode(code));

            if (result.error) {
                const info = vm.dump(result.error);
                result.error.dispose();
                throw toEngineError(info, code);
            }

            const output = vm.dump(result.value);
            result.value.dispose();
            return JSON.parse(output);
        } finally {
            vm.dispose();
        }
    } finally {
        runtime.dispose();
    }
}

module.exports = { run };
