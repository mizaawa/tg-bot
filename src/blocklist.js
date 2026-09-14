/**
 * Blacklist state helpers shared by the webhook handlers.
 */

// This fallback is useful for local development and deployments without a
// configured store, but it is intentionally process-local.
const inMemoryBlocklist = new Set();

function normalizeUid(uid) {
    return uid === undefined || uid === null ? '' : String(uid);
}

function botScope(botToken) {
    // Telegram bot tokens start with the bot's public numeric ID. Use only
    // that part for namespacing; the secret portion must never enter a key.
    const token = normalizeUid(botToken);
    const publicId = token.split(':', 1)[0];
    if (/^\d+$/.test(publicId)) {
        return publicId;
    }

    if (!token) {
        return '';
    }

    // Test/local tokens do not necessarily have Telegram's numeric prefix.
    // Use a short deterministic hash for those tokens instead of exposing the
    // token itself in a storage key.
    let hash = 2166136261;
    for (const character of token) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return `h${(hash >>> 0).toString(16)}`;
}

function blocklistKey(botToken, ownerUid, senderUid) {
    const scope = botScope(botToken);
    const scopePrefix = scope ? `${scope}:` : '';
    return `blocked:${scopePrefix}${normalizeUid(ownerUid)}:${normalizeUid(senderUid)}`;
}

export function resolveBlocklistStore(value) {
    if (!value || typeof value !== 'object') {
        return value;
    }

    if (Array.isArray(value)) {
        return value;
    }

    if (['get', 'put', 'has', 'set', 'add', 'isBlocked', 'contains', 'block', 'addBlocked']
        .some(method => typeof value[method] === 'function')) {
        return value;
    }

    const nested = value.blocklist || value.blacklist || value.blacklistStore || value.blocklistStore ||
        value.blockStore || value.storage || value.store || value.kv || value.stateStore || value.state || null;
    return nested === value ? null : resolveBlocklistStore(nested);
}

function callStoreMethod(store, method, ownerUid, senderUid) {
    const handler = store[method];
    if (handler.length <= 1) {
        // Named semantic methods receive the sender UID; get/put/has/add below
        // are the key-based interface used by KV, Map, and Set stores.
        return handler.call(store, normalizeUid(senderUid));
    }

    return handler.call(store, normalizeUid(ownerUid), normalizeUid(senderUid));
}

export async function isBlocked(store, ownerUid, senderUid, botToken) {
    const key = blocklistKey(botToken, ownerUid, senderUid);

    if (!store) {
        return inMemoryBlocklist.has(key);
    }

    if (Array.isArray(store)) {
        return store.includes(key);
    }

    if (typeof store.isBlocked === 'function') {
        return Boolean(await callStoreMethod(store, 'isBlocked', ownerUid, senderUid));
    }

    if (typeof store.contains === 'function') {
        return Boolean(await callStoreMethod(store, 'contains', ownerUid, senderUid));
    }

    if (typeof store.has === 'function') {
        return Boolean(await store.has(key));
    }

    if (typeof store.get === 'function') {
        const value = await store.get(key);
        const storedValue = value && typeof value === 'object' && 'value' in value ? value.value : value;
        // KV uses null for a missing key; any stored value represents a block.
        return storedValue !== null && storedValue !== undefined && storedValue !== false && storedValue !== 0;
    }

    throw new TypeError('The blocklist store must provide isBlocked, contains, has, or get.');
}

export async function addBlocked(store, ownerUid, senderUid, botToken) {
    const key = blocklistKey(botToken, ownerUid, senderUid);

    if (!store) {
        inMemoryBlocklist.add(key);
        return;
    }

    if (Array.isArray(store)) {
        if (!store.includes(key)) {
            store.push(key);
        }
        return;
    }

    if (typeof store.block === 'function') {
        await callStoreMethod(store, 'block', ownerUid, senderUid);
        return;
    }

    if (typeof store.addBlocked === 'function') {
        await callStoreMethod(store, 'addBlocked', ownerUid, senderUid);
        return;
    }

    if (typeof store.put === 'function') {
        await store.put(key, '1');
        return;
    }

    if (typeof store.add === 'function') {
        await store.add(key);
        return;
    }

    if (typeof store.set === 'function') {
        await store.set(key, '1');
        return;
    }

    throw new TypeError('The blocklist store must provide block, addBlocked, put, add, or set.');
}
