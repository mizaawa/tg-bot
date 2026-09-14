/**
 * Blacklist state helpers shared by the webhook handlers.
 */

// This fallback is useful for local development and deployments without a
// configured store, but it is intentionally process-local.
const inMemoryBlocklist = new Set();
const inMemoryUsernameIndex = new Map();
const collectionUsernameIndexes = new WeakMap();

function normalizeUid(uid) {
    return uid === undefined || uid === null ? '' : String(uid);
}

/**
 * Normalize a Telegram username before it is used as an index key.
 *
 * Telegram usernames are case-insensitive and are commonly written with an
 * `@` prefix. Keeping this normalization in the storage layer means command
 * handlers and message handlers use the same lookup behavior.
 */
export function normalizeUsername(username) {
    if (username === undefined || username === null) {
        return '';
    }

    return String(username)
        .trim()
        .replace(/^@+/, '')
        .trim()
        .toLowerCase();
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

function usernameIndexKey(botToken, ownerUid, username) {
    const normalized = normalizeUsername(username);
    if (!normalized) {
        return '';
    }

    const scope = botScope(botToken);
    const scopePrefix = scope ? `${scope}:` : '';
    return `user:${scopePrefix}${normalizeUid(ownerUid)}:${normalized}`;
}

function collectionUsernameIndex(store) {
    let index = collectionUsernameIndexes.get(store);
    if (!index) {
        index = new Map();
        collectionUsernameIndexes.set(store, index);
    }
    return index;
}

function parseUsernameCollectionEntry(entry, key) {
    if (typeof entry === 'string') {
        if (entry === key) {
            return {matched: true, value: null};
        }

        const prefix = `${key}=`;
        if (entry.startsWith(prefix)) {
            return {matched: true, value: entry.slice(prefix.length)};
        }

        return {matched: false, value: null};
    }

    if (!entry || typeof entry !== 'object') {
        return {matched: false, value: null};
    }

    // Accommodate simple [{key, value}] and [[key, value]] collection
    // adapters used by local/test stores.
    if (entry.key === key) {
        return {
            matched: true,
            value: entry.value === undefined ? entry.uid : entry.value
        };
    }

    if (Array.isArray(entry) && entry[0] === key) {
        return {matched: true, value: entry[1]};
    }

    return {matched: false, value: null};
}

function lookupUsernameCollection(collection, key) {
    if (Array.isArray(collection)) {
        for (let index = collection.length - 1; index >= 0; index -= 1) {
            const parsed = parseUsernameCollectionEntry(collection[index], key);
            if (parsed.matched && parsed.value !== undefined && parsed.value !== null) {
                return normalizeUid(parsed.value);
            }
        }
        return null;
    }

    if (collection instanceof Set) {
        const entries = [...collection];
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const parsed = parseUsernameCollectionEntry(entries[index], key);
            if (parsed.matched && parsed.value !== undefined && parsed.value !== null) {
                return normalizeUid(parsed.value);
            }
        }
    }

    return null;
}

function unwrapStoreValue(value) {
    if (value && typeof value === 'object' && 'value' in value) {
        return value.value;
    }
    return value;
}

function normalizeLookupValue(value) {
    const unwrapped = unwrapStoreValue(value);
    return unwrapped === undefined || unwrapped === null || unwrapped === '' || unwrapped === false
        ? null
        : normalizeUid(unwrapped);
}

function callUsernameMethod(store, method, ownerUid, username, senderUid, botToken) {
    const handler = store[method];
    const owner = normalizeUid(ownerUid);
    const normalized = normalizeUsername(username);
    const sender = normalizeUid(senderUid);

    // Semantic adapters generally use (owner, username, sender, botToken),
    // but honoring the declared arity keeps one-argument test adapters useful.
    if (handler.length <= 1) {
        return handler.call(store, normalized);
    }
    if (handler.length === 2) {
        return handler.call(store, owner, normalized);
    }
    if (handler.length === 3) {
        return handler.call(store, owner, normalized, sender);
    }
    return handler.call(store, owner, normalized, sender, botToken);
}

function callUsernameLookupMethod(store, method, ownerUid, username, botToken) {
    const handler = store[method];
    const owner = normalizeUid(ownerUid);
    const normalized = normalizeUsername(username);

    if (handler.length <= 1) {
        return handler.call(store, normalized);
    }
    if (handler.length === 2) {
        return handler.call(store, owner, normalized);
    }
    if (handler.length === 3) {
        return handler.call(store, owner, normalized, botToken);
    }
    return handler.call(store, owner, normalized, undefined, botToken);
}

export function resolveBlocklistStore(value) {
    if (!value || typeof value !== 'object') {
        return value;
    }

    if (Array.isArray(value)) {
        return value;
    }

    if (['get', 'put', 'has', 'set', 'add', 'delete', 'remove', 'isBlocked', 'contains', 'block', 'addBlocked',
        'unblock', 'removeBlocked', 'rememberUsername', 'recordUsername', 'lookupUsername',
        'getUsernameUid', 'setUsername', 'getUsername']
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

/**
 * Remove a sender from the blacklist.
 *
 * The implementation mirrors addBlocked and deliberately supports both
 * semantic adapters and ordinary KV/Map/Set/array stores.
 */
export async function removeBlocked(store, ownerUid, senderUid, botToken) {
    const key = blocklistKey(botToken, ownerUid, senderUid);

    if (!store) {
        return inMemoryBlocklist.delete(key);
    }

    if (Array.isArray(store)) {
        let removed = false;
        for (let index = store.length - 1; index >= 0; index -= 1) {
            if (store[index] === key) {
                store.splice(index, 1);
                removed = true;
            }
        }
        return removed;
    }

    if (typeof store.unblock === 'function') {
        const result = await callStoreMethod(store, 'unblock', ownerUid, senderUid);
        return result === undefined ? true : Boolean(result);
    }

    if (typeof store.removeBlocked === 'function') {
        const result = await callStoreMethod(store, 'removeBlocked', ownerUid, senderUid);
        return result === undefined ? true : Boolean(result);
    }

    if (typeof store.delete === 'function') {
        const result = await store.delete(key);
        return result === undefined ? true : Boolean(result);
    }

    if (typeof store.remove === 'function') {
        const result = await store.remove(key);
        return result === undefined ? true : Boolean(result);
    }

    throw new TypeError('The blocklist store must provide unblock, removeBlocked, delete, or remove.');
}

/**
 * Remember the UID associated with a username for this bot/owner pair.
 * Telegram does not offer a username-to-private-chat lookup API, so handlers
 * call this whenever a message reveals both fields.
 */
export async function rememberUsername(store, ownerUid, username, senderUid, botToken) {
    const key = usernameIndexKey(botToken, ownerUid, username);
    const value = normalizeUid(senderUid);

    if (!key || !value) {
        return false;
    }

    if (!store) {
        inMemoryUsernameIndex.set(key, value);
        return true;
    }

    if (Array.isArray(store) || store instanceof Set) {
        collectionUsernameIndex(store).set(key, value);
        return true;
    }

    if (typeof store.rememberUsername === 'function' || typeof store.recordUsername === 'function') {
        const method = typeof store.rememberUsername === 'function' ? 'rememberUsername' : 'recordUsername';
        await callUsernameMethod(store, method, ownerUid, username, senderUid, botToken);
        return true;
    }

    if (typeof store.setUsername === 'function') {
        await callUsernameMethod(store, 'setUsername', ownerUid, username, senderUid, botToken);
        return true;
    }

    if (typeof store.put === 'function') {
        await store.put(key, value);
        return true;
    }

    // Map-like stores expose set; native Set/Array stores use the sidecar path above.
    if (typeof store.set === 'function') {
        await store.set(key, value);
        return true;
    }

    // A blocklist-only adapter can still support username commands for the
    // lifetime of this runtime even when it has no separate index API.
    inMemoryUsernameIndex.set(key, value);
    return true;
}

/**
 * Resolve a previously seen username to its Telegram user ID.
 * Returns null when no mapping is available.
 */
export async function lookupUsername(store, ownerUid, username, botToken) {
    const key = usernameIndexKey(botToken, ownerUid, username);

    if (!key) {
        return null;
    }

    if (!store) {
        return inMemoryUsernameIndex.get(key) ?? null;
    }

    if (Array.isArray(store) || store instanceof Set) {
        const indexedValue = collectionUsernameIndexes.get(store)?.get(key);
        if (indexedValue !== undefined) {
            return normalizeUid(indexedValue);
        }
        return lookupUsernameCollection(store, key) ?? (inMemoryUsernameIndex.get(key) ?? null);
    }

    if (typeof store.lookupUsername === 'function' || typeof store.getUsernameUid === 'function') {
        const method = typeof store.lookupUsername === 'function' ? 'lookupUsername' : 'getUsernameUid';
        const value = await callUsernameLookupMethod(store, method, ownerUid, username, botToken);
        return normalizeLookupValue(value) ?? (inMemoryUsernameIndex.get(key) ?? null);
    }

    if (typeof store.getUsername === 'function') {
        const value = await callUsernameLookupMethod(store, 'getUsername', ownerUid, username, botToken);
        return normalizeLookupValue(value) ?? (inMemoryUsernameIndex.get(key) ?? null);
    }

    if (typeof store.get === 'function') {
        return normalizeLookupValue(await store.get(key)) ?? (inMemoryUsernameIndex.get(key) ?? null);
    }

    return inMemoryUsernameIndex.get(key) ?? null;
}

// Naming aliases kept for adapters that describe the index as a record rather
// than a remembered username. The canonical functions above remain the ones
// used by the webhook handler.
export const recordUsername = rememberUsername;
export const getUsernameUid = lookupUsername;
