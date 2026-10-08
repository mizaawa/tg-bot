import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate} from 'node:timers/promises';

import worker from '../src/worker.js';

function callbackRequest(data = 'block:987654') {
    return new Request('https://example.com/public/webhook/123456/telegram-bot-token', {
        method: 'POST',
        body: JSON.stringify({
            callback_query: {
                id: 'callback-timeout',
                from: {id: 123456},
                message: {
                    chat: {id: 123456},
                    message_id: 10,
                    reply_markup: {
                        inline_keyboard: [[
                            {text: 'From Alice', callback_data: '987654'},
                            {text: 'Toggle forwarding', callback_data: data}
                        ]]
                    }
                },
                data
            }
        })
    });
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}

test('acknowledges the click through the webhook while a keyboard edit is pending', async (t) => {
    const edit = deferred();
    const tasks = [];
    const methods = [];
    const blocked = new Set();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        methods.push(url.split('/').at(-1));
        if (url.endsWith('/editMessageReplyMarkup')) {
            await edit.promise;
        }
        return new Response(JSON.stringify({ok: true}));
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    let completed = false;
    const responsePromise = worker.fetch(callbackRequest(), {BLOCKLIST: blocked}, {
        waitUntil(task) { tasks.push(task); }
    }).then(response => {
        completed = true;
        return response;
    });

    await setImmediate();
    const acknowledgedBeforeEdit = completed;
    edit.resolve();
    const response = await responsePromise;
    await Promise.all(tasks);

    assert.equal(acknowledgedBeforeEdit, true);
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.method, 'answerCallbackQuery');
    assert.equal(answer.callback_query_id, 'callback-timeout');
    assert.equal(blocked.has('blocked:h24ccbb4a:123456:987654'), true);
    assert.deepEqual(methods, ['editMessageReplyMarkup']);
    assert.equal(tasks.length, 1);
});

test('bounds a stuck blocklist write or removal and reports failure without editing the button', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const calls = [];
    const errors = [];
    globalThis.fetch = async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ok: true}));
    };
    console.error = (...args) => errors.push(args);
    t.after(() => {
        globalThis.fetch = originalFetch;
        console.error = originalConsoleError;
    });

    for (const action of ['block', 'unblock']) {
        const storage = deferred();
        const blocklist = {
            get: async () => null,
            put: () => storage.promise,
            delete: () => storage.promise
        };
        let completed = false;
        const responsePromise = worker.fetch(callbackRequest(`${action}:987654`), {
            BLOCKLIST: blocklist
        }).then(response => {
            completed = true;
            return response;
        });

        await setImmediate();
        t.mock.timers.tick(10000);
        await setImmediate();
        const completedWithinCallbackWindow = completed;
        storage.resolve();
        const response = await responsePromise;

        assert.equal(completedWithinCallbackWindow, true, action);
        assert.equal(response.status, 200);
        const answer = await response.json();
        assert.equal(answer.method, 'answerCallbackQuery');
        assert.equal(answer.show_alert, true);
        assert.equal(calls.length, 0);
    }
    assert.equal(errors.length, 2);
    assert.equal(errors.every(args => args[1].name === 'TimeoutError'), true);
});

test('bounds and aborts a stalled keyboard request without an execution context', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const edit = deferred();
    const blocked = new Set();
    const errors = [];
    let editSignal;
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = async (url, init) => {
        if (url.endsWith('/editMessageReplyMarkup')) {
            editSignal = init.signal;
            await edit.promise;
        }
        return new Response(JSON.stringify({ok: true}));
    };
    console.error = (...args) => errors.push(args);
    t.after(() => {
        globalThis.fetch = originalFetch;
        console.error = originalConsoleError;
    });

    let completed = false;
    const responsePromise = worker.fetch(callbackRequest(), {BLOCKLIST: blocked}).then(response => {
        completed = true;
        return response;
    });
    await setImmediate();
    t.mock.timers.tick(10000);
    await setImmediate();
    const completedWithinCallbackWindow = completed;
    edit.resolve();
    const response = await responsePromise;
    await setImmediate();

    assert.equal(completedWithinCallbackWindow, true);
    assert.equal(editSignal.aborted, true);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).method, 'answerCallbackQuery');
    assert.equal(blocked.has('blocked:h24ccbb4a:123456:987654'), true);
    assert.equal(errors.some(args => args[1].name === 'TimeoutError'), true);
});

test('bounds a stalled Telegram response body as well as the request', async (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const body = deferred();
    let signal;
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = async (_url, init) => {
        signal = init.signal;
        const response = {
            ok: true,
            status: 200,
            json: () => body.promise
        };
        return response;
    };
    console.error = () => {};
    t.after(() => {
        globalThis.fetch = originalFetch;
        console.error = originalConsoleError;
    });

    let completed = false;
    const responsePromise = worker.fetch(callbackRequest(), {BLOCKLIST: new Set()}).then(response => {
        completed = true;
        return response;
    });
    await setImmediate();
    t.mock.timers.tick(10000);
    await setImmediate();
    const completedWithinCallbackWindow = completed;
    body.resolve({ok: true});
    const response = await responsePromise;

    assert.equal(completedWithinCallbackWindow, true);
    assert.equal(signal.aborted, true);
    assert.equal((await response.json()).method, 'answerCallbackQuery');
});

test('reports storage failures through the webhook without changing the keyboard', async (t) => {
    const calls = [];
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ok: true}));
    };
    console.error = () => {};
    t.after(() => {
        globalThis.fetch = originalFetch;
        console.error = originalConsoleError;
    });

    for (const failure of [new Error('storage unavailable'), null]) {
        const response = await worker.fetch(callbackRequest(), {
            BLOCKLIST: {
                get: async () => null,
                put: async () => { throw failure; }
            }
        });

        assert.equal(response.status, 200);
        const answer = await response.json();
        assert.equal(answer.method, 'answerCallbackQuery');
        assert.equal(answer.show_alert, true);
        assert.equal(answer.callback_query_id, 'callback-timeout');
        assert.equal(calls.length, 0);
    }
});
