import assert from 'node:assert/strict';
import test from 'node:test';

import worker, {resolveSecretToken} from '../src/worker.js';
import {handleWebhook} from '../src/core.js';

const SECRET_TOKEN = 'ValidSecretToken123';

test('resolves a traditional Worker secret', async () => {
    assert.equal(await resolveSecretToken(SECRET_TOKEN), SECRET_TOKEN);
});

test('resolves a Cloudflare Secrets Store binding', async () => {
    const binding = {
        async get() {
            return SECRET_TOKEN;
        }
    };

    assert.equal(await resolveSecretToken(binding), SECRET_TOKEN);
});

test('uses the value from a Secrets Store binding when installing a webhook', async (t) => {
    let telegramRequest;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        telegramRequest = {url, init};
        return new Response(JSON.stringify({ok: true}), {
            headers: {'Content-Type': 'application/json'}
        });
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://example.com/public/install/123456/telegram-bot-token'),
        {
            PREFIX: 'public',
            SECRET_TOKEN: {get: async () => SECRET_TOKEN}
        }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        success: true,
        message: 'Webhook successfully installed.'
    });
    assert.equal(telegramRequest.url, 'https://api.telegram.org/bottelegram-bot-token/setWebhook');
    assert.equal(JSON.parse(telegramRequest.init.body).secret_token, SECRET_TOKEN);
});

test('installs a webhook without a secret token when no binding exists', async (t) => {
    let telegramBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        telegramBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ok: true}), {
            headers: {'Content-Type': 'application/json'}
        });
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://example.com/public/install/123456/telegram-bot-token'),
        {}
    );

    assert.equal(response.status, 200);
    assert.equal('secret_token' in telegramBody, false);
});

test('accepts a webhook without a secret header when no binding exists', async () => {
    const response = await worker.fetch(
        new Request('https://example.com/public/webhook/123456/telegram-bot-token', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: '{}'
        }),
        {}
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'OK');
});

test('reports a Secrets Store read failure without calling Telegram', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = async () => {
        assert.fail('Telegram must not be called when the secret cannot be read');
    };
    console.error = () => {};
    t.after(() => {
        globalThis.fetch = originalFetch;
        console.error = originalConsoleError;
    });

    const response = await worker.fetch(
        new Request('https://example.com/public/install/123456/telegram-bot-token'),
        {
            SECRET_TOKEN: {get: async () => { throw new Error('unavailable'); }}
        }
    );

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
        success: false,
        message: 'Failed to read SECRET_TOKEN from the Cloudflare binding.'
    });
});

test('installs callback query updates for the blacklist button', async (t) => {
    let telegramBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        telegramBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ok: true}), {
            headers: {'Content-Type': 'application/json'}
        });
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://example.com/public/install/123456/telegram-bot-token'),
        {}
    );

    assert.equal(response.status, 200);
    assert.deepEqual(telegramBody.allowed_updates, ['message', 'callback_query']);
});

test('forwards a message with a blacklist button and blocks later messages', async (t) => {
    const telegramCalls = [];
    const blocked = new Set();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        telegramCalls.push({url, body: JSON.parse(init.body)});
        return new Response(JSON.stringify({ok: true}), {
            headers: {'Content-Type': 'application/json'}
        });
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const webhookUrl = 'https://example.com/public/webhook/123456/telegram-bot-token';
    const firstMessage = await worker.fetch(
        new Request(webhookUrl, {
            method: 'POST',
            body: JSON.stringify({
                message: {chat: {id: 987654, first_name: 'Alice'}, message_id: 10, text: 'hello'}
            })
        }),
        {BLOCKLIST: blocked}
    );

    assert.equal(firstMessage.status, 200);
    assert.equal(telegramCalls.length, 1);
    const keyboard = telegramCalls[0].body.reply_markup.inline_keyboard;
    assert.equal(keyboard[0][1].callback_data, 'block:987654');

    const callback = await worker.fetch(
        new Request(webhookUrl, {
            method: 'POST',
            body: JSON.stringify({
                callback_query: {
                    id: 'callback-1',
                    from: {id: 123456},
                    message: {chat: {id: 123456}, message_id: 10},
                    data: 'block:987654'
                }
            })
        }),
        {BLOCKLIST: blocked}
    );

    assert.equal(callback.status, 200);
    assert.equal(telegramCalls[telegramCalls.length - 1].url.endsWith('/answerCallbackQuery'), true);
    assert.equal(blocked.has('blocked:h24ccbb4a:123456:987654'), true);

    const blockedMessage = await worker.fetch(
        new Request(webhookUrl, {
            method: 'POST',
            body: JSON.stringify({
                message: {chat: {id: 987654, first_name: 'Alice'}, message_id: 11, text: 'again'}
            })
        }),
        {BLOCKLIST: blocked}
    );

    assert.equal(blockedMessage.status, 200);
    assert.equal(telegramCalls.length, 2);
});

test('does not let another Telegram user trigger a blacklist callback', async (t) => {
    const blocked = new Set();
    const telegramCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        telegramCalls.push({url, body: JSON.parse(init.body)});
        return new Response(JSON.stringify({ok: true}), {
            headers: {'Content-Type': 'application/json'}
        });
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://example.com/public/webhook/123456/telegram-bot-token', {
            method: 'POST',
            body: JSON.stringify({
                callback_query: {
                    id: 'callback-2',
                    from: {id: 999999},
                    message: {chat: {id: 123456}, message_id: 10},
                    data: 'block:987654'
                }
            })
        }),
        {BLOCKLIST: blocked}
    );

    assert.equal(response.status, 200);
    assert.equal(blocked.size, 0);
    assert.equal(telegramCalls.length, 1);
    assert.equal(telegramCalls[0].url.endsWith('/answerCallbackQuery'), true);
});

test('keeps the sender button usable for owner replies', async (t) => {
    let telegramRequest;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        telegramRequest = {url, body: JSON.parse(init.body)};
        return new Response(JSON.stringify({ok: true}), {
            headers: {'Content-Type': 'application/json'}
        });
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://example.com/public/webhook/123456/telegram-bot-token', {
            method: 'POST',
            body: JSON.stringify({
                message: {
                    chat: {id: 123456},
                    message_id: 12,
                    reply_to_message: {
                        reply_markup: {
                            inline_keyboard: [[
                                {text: 'From Alice', url: 'tg://user?id=987654'},
                                {text: '🚫 拉黑此账号', callback_data: 'block:987654'}
                            ]]
                        }
                    },
                    text: 'reply'
                }
            })
        }),
        {}
    );

    assert.equal(response.status, 200);
    assert.equal(telegramRequest.url.endsWith('/copyMessage'), true);
    assert.equal(telegramRequest.body.chat_id, 987654);
});

test('uses a KV-style blocklist binding across requests', async (t) => {
    const values = new Map();
    const blocklist = {
        async get(key) {
            return values.get(key) ?? null;
        },
        async put(key, value) {
            values.set(key, value);
        }
    };
    const telegramCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        telegramCalls.push({url, body: JSON.parse(init.body)});
        return new Response(JSON.stringify({ok: true}));
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const webhookUrl = 'https://example.com/public/webhook/333333/telegram-bot-token';
    const request = (body) => new Request(webhookUrl, {
        method: 'POST',
        body: JSON.stringify(body)
    });

    await worker.fetch(request({
        callback_query: {
            id: 'callback-kv',
            from: {id: 333333},
            message: {chat: {id: 333333}},
            data: 'block:444444'
        }
    }), {BLOCKLIST: blocklist});

    await worker.fetch(request({
        message: {chat: {id: 444444}, message_id: 20, text: 'blocked'}
    }), {BLOCKLIST: blocklist});

    assert.deepEqual([...values.entries()], [['blocked:h24ccbb4a:333333:444444', '1']]);
    assert.equal(telegramCalls.filter(call => call.url.endsWith('/copyMessage')).length, 0);
});

test('keeps the blacklist button when Telegram rejects the user-link keyboard', async (t) => {
    const copyBodies = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith('/copyMessage')) {
            copyBodies.push(body);
            return new Response(JSON.stringify({ok: copyBodies.length > 1}), {
                status: copyBodies.length > 1 ? 200 : 400
            });
        }
        return new Response(JSON.stringify({ok: true}));
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://example.com/public/webhook/123456/telegram-bot-token', {
            method: 'POST',
            body: JSON.stringify({
                message: {chat: {id: 654321}, message_id: 30, text: 'hello'}
            })
        }),
        {}
    );

    assert.equal(response.status, 200);
    assert.equal(copyBodies.length, 2);
    assert.equal(copyBodies[0].reply_markup.inline_keyboard[0][1].callback_data, 'block:654321');
    assert.equal(copyBodies[1].reply_markup.inline_keyboard[0][1].callback_data, 'block:654321');
});

test('keeps blacklists isolated between bot IDs', async (t) => {
    const values = new Map();
    const blocklist = {
        async get(key) {
            return values.get(key) ?? null;
        },
        async put(key, value) {
            values.set(key, value);
        }
    };
    const copyCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (url.endsWith('/copyMessage')) {
            copyCalls.push(url);
        }
        return new Response(JSON.stringify({ok: true}));
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const callback = (token) => new Request(`https://example.com/public/webhook/123456/${token}`, {
        method: 'POST',
        body: JSON.stringify({
            callback_query: {
                id: `callback-${token}`,
                from: {id: 123456},
                message: {chat: {id: 123456}},
                data: 'block:987654'
            }
        })
    });
    await worker.fetch(callback('111111:secret-a'), {BLOCKLIST: blocklist});

    await worker.fetch(new Request('https://example.com/public/webhook/123456/222222:secret-b', {
        method: 'POST',
        body: JSON.stringify({message: {chat: {id: 987654}, message_id: 40}})
    }), {BLOCKLIST: blocklist});

    assert.equal(copyCalls.length, 1);
    assert.equal(values.has('blocked:111111:123456:987654'), true);
});

test('ignores malformed callback query payloads', async (t) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true}));
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const response = await worker.fetch(
        new Request('https://example.com/public/webhook/123456/telegram-bot-token', {
            method: 'POST',
            body: JSON.stringify({callback_query: null})
        }),
        {}
    );

    assert.equal(response.status, 200);
});

test('accepts a nested blocklist store when calling the webhook handler directly', async (t) => {
    const blocked = new Set();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ok: true}));
    t.after(() => {
        globalThis.fetch = originalFetch;
    });

    const response = await handleWebhook(
        new Request('https://example.com/public/webhook/123456/telegram-bot-token', {
            method: 'POST',
            body: JSON.stringify({
                callback_query: {
                    id: 'callback-direct',
                    from: {id: 123456},
                    message: {chat: {id: 123456}},
                    data: 'block:987654'
                }
            })
        }),
        '123456',
        'telegram-bot-token',
        '',
        {blocklist: blocked}
    );

    assert.equal(response.status, 200);
    assert.equal(blocked.size, 1);
});
