import assert from 'node:assert/strict';
import test from 'node:test';

import worker, {resolveSecretToken} from '../src/worker.js';

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
