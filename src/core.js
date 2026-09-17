/**
 * Open Wegram Bot - Core Logic
 * Shared code between Cloudflare Worker and Vercel deployments
 */

import {
    addBlocked,
    isBlocked,
    lookupUsername,
    normalizeUsername,
    rememberUsername,
    removeBlocked,
    resolveBlocklistStore
} from './blocklist.js';

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {'Content-Type': 'application/json'}
    });
}

function normalizeUid(uid) {
    return uid === undefined || uid === null ? '' : String(uid);
}

function sameUid(left, right) {
    const normalizedLeft = normalizeUid(left);
    const normalizedRight = normalizeUid(right);

    if (normalizedLeft === normalizedRight) {
        return true;
    }

    // Telegram IDs are numeric, but accepting equivalent numeric strings keeps
    // webhook data compatible with configuration values such as "001234".
    return normalizedLeft !== '' && normalizedRight !== '' &&
        /^-?\d+$/.test(normalizedLeft) && /^-?\d+$/.test(normalizedRight) &&
        Number(normalizedLeft) === Number(normalizedRight);
}

function extractSenderUid(reply) {
    const keyboard = reply && reply.reply_markup && reply.reply_markup.inline_keyboard;
    if (!Array.isArray(keyboard)) {
        return null;
    }

    for (const row of keyboard) {
        if (!Array.isArray(row)) {
            continue;
        }

        for (const button of row) {
            if (!button) {
                continue;
            }

            if ((typeof button.callback_data === 'string' || typeof button.callback_data === 'number') &&
                /^-?\d+$/.test(String(button.callback_data))) {
                return String(button.callback_data);
            }

            if (typeof button.url === 'string' && button.url.startsWith('tg://user?id=')) {
                const uid = button.url.slice('tg://user?id='.length);
                if (/^-?\d+$/.test(uid)) {
                    return uid;
                }
            }
        }
    }

    return null;
}

export async function postToTelegramApi(token, method, body) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });
}

async function ensureTelegramApiSuccess(response, method) {
    let result = null;
    try {
        result = await response.clone().json();
    } catch {
        // HTTP status still provides a useful failure when Telegram does not
        // return its usual JSON envelope.
    }

    if (!response.ok || (result && result.ok === false)) {
        const detail = result && result.description ? result.description : `HTTP ${response.status}`;
        throw new Error(`${method} failed: ${detail}`);
    }
}

async function answerCallbackQuery(botToken, callbackQueryId, text, showAlert = false) {
    if (!callbackQueryId) {
        return;
    }

    try {
        const body = {callback_query_id: callbackQueryId};
        if (text) {
            body.text = text;
        }
        if (showAlert) {
            body.show_alert = true;
        }
        const response = await postToTelegramApi(botToken, 'answerCallbackQuery', body);
        await ensureTelegramApiSuccess(response, 'answerCallbackQuery');
    } catch (error) {
        // A callback answer is cosmetic. Do not turn a successfully persisted
        // filtering change into a webhook retry when Telegram is unavailable.
        console.error('Error answering callback query:', error);
    }
}

async function sendOwnerMessage(botToken, ownerUid, text) {
    try {
        const response = await postToTelegramApi(botToken, 'sendMessage', {
            chat_id: parseInt(ownerUid),
            text
        });
        await ensureTelegramApiSuccess(response, 'sendMessage');
    } catch (error) {
        // Management feedback must not make Telegram retry the webhook. The
        // state operation itself is handled by the caller before this point.
        console.error('Error sending management message:', error);
    }
}

function cloneInlineKeyboard(keyboard) {
    if (!Array.isArray(keyboard)) {
        return [];
    }

    return keyboard
        .filter(row => Array.isArray(row))
        .map(row => row
            .filter(button => button && typeof button === 'object')
            .map(button => ({...button})));
}

function stateKeyboardForCallback(callbackQuery, senderUid, blocked) {
    const message = callbackQuery && callbackQuery.message;
    const current = message && message.reply_markup && message.reply_markup.inline_keyboard;
    const keyboard = cloneInlineKeyboard(current);
    const action = {
        text: blocked ? '✅ 恢复转发' : '🚫 停止转发',
        callback_data: `${blocked ? 'unblock' : 'block'}:${senderUid}`
    };

    let replaced = false;
    for (const row of keyboard) {
        for (let index = 0; index < row.length; index += 1) {
            const callbackData = row[index] && row[index].callback_data;
            if (typeof callbackData === 'string' && /^(?:block|unblock):-?\d+$/.test(callbackData)) {
                row[index] = action;
                replaced = true;
            }
        }
    }

    if (!replaced) {
        if (!keyboard.length) {
            keyboard.push([]);
        }
        keyboard[0].push(action);
    }

    return {inline_keyboard: keyboard};
}

async function editCallbackKeyboard(botToken, callbackQuery, senderUid, blocked) {
    const message = callbackQuery && callbackQuery.message;
    if (!message || message.chat === undefined || message.message_id === undefined) {
        return;
    }

    // Telegram includes the original inline keyboard in callback updates. If
    // an old/test update omits it, avoid issuing an edit with a guessed
    // keyboard and retain the acknowledgement-only behavior.
    const currentKeyboard = message.reply_markup && message.reply_markup.inline_keyboard;
    if (!Array.isArray(currentKeyboard)) {
        return;
    }

    try {
        const response = await postToTelegramApi(botToken, 'editMessageReplyMarkup', {
            chat_id: message.chat.id,
            message_id: message.message_id,
            reply_markup: stateKeyboardForCallback(callbackQuery, senderUid, blocked)
        });
        await ensureTelegramApiSuccess(response, 'editMessageReplyMarkup');
    } catch (error) {
        // A stale/deleted forwarded message should not undo a successful list
        // mutation. The next webhook can still use the persisted state.
        console.error('Error editing blacklist button:', error);
    }
}

function parseManagementCommand(text) {
    if (typeof text !== 'string') {
        return null;
    }

    const match = text.trim().match(/^\/(ban|recover)(?:@[A-Za-z0-9_]+)?(?:\s+(.+?))?$/i);
    if (!match) {
        return null;
    }

    return {
        action: match[1].toLowerCase(),
        username: match[2] ? match[2].trim() : ''
    };
}

function validManagementUsername(username) {
    const normalized = normalizeUsername(username);
    return /^[A-Za-z0-9_]{1,64}$/.test(normalized) ? normalized : '';
}

async function rememberMessageUser(blocklist, ownerUid, message, botToken) {
    const candidates = [];
    const from = message && message.from;
    const chat = message && message.chat;

    if (from && from.username && from.id !== undefined && from.id !== null) {
        candidates.push({username: from.username, uid: from.id});
    }
    if (chat && chat.username && chat.id !== undefined && chat.id !== null) {
        candidates.push({username: chat.username, uid: chat.id});
    }

    const seen = new Set();
    for (const candidate of candidates) {
        const normalized = normalizeUsername(candidate.username);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        try {
            await rememberUsername(blocklist, ownerUid, normalized, candidate.uid, botToken);
        } catch (error) {
            // Username indexing is an enhancement for command lookup. A KV
            // outage must not prevent the normal message path from running.
            console.error('Error remembering Telegram username:', error);
        }
    }
}

async function handleManagementCommand(command, ownerUid, botToken, blocklist) {
    const username = validManagementUsername(command.username);
    if (!username) {
        await sendOwnerMessage(
            botToken,
            ownerUid,
            `用法：/${command.action} @用户名`
        );
        return;
    }

    let senderUid;
    try {
        senderUid = await lookupUsername(blocklist, ownerUid, username, botToken);
    } catch (error) {
        console.error('Error looking up Telegram username:', error);
        await sendOwnerMessage(botToken, ownerUid, '暂时无法查询该账号，请稍后重试');
        return;
    }

    if (senderUid === null || senderUid === undefined || senderUid === '') {
        await sendOwnerMessage(
            botToken,
            ownerUid,
            `未找到 @${username}。请先让该账号给 Bot 发送过消息。`
        );
        return;
    }

    try {
        if (command.action === 'ban') {
            await addBlocked(blocklist, ownerUid, senderUid, botToken);
            await sendOwnerMessage(
                botToken,
                ownerUid,
                blocklist
                    ? `已停止转发 @${username} 的后续消息`
                    : `已临时停止转发 @${username} 的消息；未配置 BLOCKLIST，运行实例重启后会失效`
            );
        } else {
            await removeBlocked(blocklist, ownerUid, senderUid, botToken);
            await sendOwnerMessage(botToken, ownerUid, `已恢复转发 @${username} 的消息`);
        }
    } catch (error) {
        console.error(`Error handling /${command.action}:`, error);
        await sendOwnerMessage(
            botToken,
            ownerUid,
            `暂时无法${command.action === 'ban' ? '拉黑' : '恢复'}该账号，请稍后重试`
        );
    }
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.hostname}`;
    const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

    try {
        const webhook = {
            url: webhookUrl,
            allowed_updates: ['message', 'callback_query']
        };
        if (secretToken) {
            webhook.secret_token = secretToken;
        }

        const response = await postToTelegramApi(botToken, 'setWebhook', webhook);

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully installed.'});
        }

        return jsonResponse({success: false, message: `Failed to install webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error installing webhook: ${error.message}`}, 500);
    }
}

export async function handleUninstall(botToken) {
    try {
        const response = await postToTelegramApi(botToken, 'deleteWebhook', {})

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully uninstalled.'});
        }

        return jsonResponse({success: false, message: `Failed to uninstall webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error uninstalling webhook: ${error.message}`}, 500);
    }
}

async function handleCallbackQuery(callbackQuery, ownerUid, botToken, blocklist) {
    if (!callbackQuery || typeof callbackQuery !== 'object' || Array.isArray(callbackQuery)) {
        return new Response('OK');
    }

    const callbackOwnerUid = callbackQuery && callbackQuery.from && callbackQuery.from.id;
    const callbackChatUid = callbackQuery && callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;

    // A callback is only allowed to mutate the list when it was clicked by the
    // configured owner in the owner's private chat.
    if (!sameUid(callbackOwnerUid, ownerUid) || !sameUid(callbackChatUid, ownerUid)) {
        await answerCallbackQuery(botToken, callbackQuery && callbackQuery.id, '无权操作', true);
        return new Response('OK');
    }

    const data = callbackQuery.data === undefined || callbackQuery.data === null ? '' : String(callbackQuery.data);
    const match = data.match(/^(block|unblock):(-?\d+)$/);
    if (!match) {
        // The first sender button used raw numeric callback data in older
        // forwarded messages. Keep those callbacks inert and silent.
        if (/^-?\d+$/.test(data)) {
            await answerCallbackQuery(botToken, callbackQuery.id);
            return new Response('OK');
        }
        await answerCallbackQuery(botToken, callbackQuery.id, '无效的操作', true);
        return new Response('OK');
    }

    try {
        if (match[1] === 'block') {
            await addBlocked(blocklist, ownerUid, match[2], botToken);
        } else {
            await removeBlocked(blocklist, ownerUid, match[2], botToken);
        }
    } catch (error) {
        console.error(`Error ${match[1] === 'block' ? 'saving' : 'removing'} blocked account:`, error);
        await answerCallbackQuery(
            botToken,
            callbackQuery.id,
            `暂时无法${match[1] === 'block' ? '停止转发' : '恢复转发'}，请稍后重试`,
            true
        );
        return new Response('OK');
    }

    const isBlocking = match[1] === 'block';
    const feedback = isBlocking
        ? (blocklist
            ? '已停止转发此账号的后续消息'
            : '已临时停止转发；未配置 BLOCKLIST，运行实例重启后会失效')
        : '已恢复转发此账号的消息';

    // Acknowledge first so Telegram immediately clears the button's loading
    // state. Editing an old or deleted message must not make the click appear
    // to have failed after the filtering state was already changed.
    await answerCallbackQuery(
        botToken,
        callbackQuery.id,
        feedback,
        isBlocking && !blocklist
    );
    await editCallbackKeyboard(botToken, callbackQuery, match[2], isBlocking);

    return new Response('OK');
}

export async function handleWebhook(request, ownerUid, botToken, secretToken, blocklist) {
    if (secretToken && typeof secretToken === 'object') {
        const options = secretToken;
        secretToken = typeof options.secretToken === 'string' ? options.secretToken : '';
        blocklist = blocklist || options;
    }

    if (secretToken && secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', {status: 401});
    }

    blocklist = resolveBlocklistStore(blocklist);

    try {
        const update = await request.json();

        if (!update || typeof update !== 'object') {
            return new Response('OK');
        }

        if (update.callback_query !== undefined && update.callback_query !== null) {
            return await handleCallbackQuery(update.callback_query, ownerUid, botToken, blocklist);
        }

        if (!update.message) {
            return new Response('OK');
        }

        const message = update.message;
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return new Response('OK');
        }

        if (!message.chat || message.chat.id === undefined || message.chat.id === null) {
            return new Response('OK');
        }

        // Keep a best-effort username -> UID index for administrative commands.
        // It is intentionally populated before the block check so an already
        // blocked account can still refresh its known username mapping.
        await rememberMessageUser(blocklist, ownerUid, message, botToken);

        const managementCommand = parseManagementCommand(message.text);
        const messageFromOwner = !message.from || message.from.id === undefined || message.from.id === null ||
            sameUid(message.from.id, ownerUid);
        if (managementCommand && sameUid(message.chat.id, ownerUid) && messageFromOwner) {
            await handleManagementCommand(managementCommand, ownerUid, botToken, blocklist);
            return new Response('OK');
        }

        const reply = message.reply_to_message;

        if (reply && sameUid(message.chat && message.chat.id, ownerUid)) {
            const senderUid = extractSenderUid(reply);
            if (senderUid !== null && !(await isBlocked(blocklist, ownerUid, senderUid, botToken))) {
                await postToTelegramApi(botToken, 'copyMessage', {
                    chat_id: parseInt(senderUid),
                    from_chat_id: message.chat.id,
                    message_id: message.message_id
                });
            }

            return new Response('OK');
        }

        if ("/start" === message.text) {
            return new Response('OK');
        }

        const sender = message.chat;
        const senderUid = sender.id.toString();
        if (await isBlocked(blocklist, ownerUid, senderUid, botToken)) {
            return new Response('OK');
        }

        const senderName = sender.username ? `@${sender.username}` : [sender.first_name, sender.last_name].filter(Boolean).join(' ');

        const copyMessage = async function (withUrl = false) {
            const senderButton = {
                text: `${withUrl ? '🔓' : '🔏'} From: ${senderName} (${senderUid})`,
                callback_data: senderUid,
            };
            if (withUrl) {
                delete senderButton.callback_data;
                senderButton.url = `tg://user?id=${senderUid}`;
            }

            const ik = [[
                senderButton,
                {
                    text: '🚫 停止转发',
                    callback_data: `block:${senderUid}`
                }
            ]];

            return await postToTelegramApi(botToken, 'copyMessage', {
                chat_id: parseInt(ownerUid),
                from_chat_id: message.chat.id,
                message_id: message.message_id,
                reply_markup: {inline_keyboard: ik}
            });
        }

        const response = await copyMessage(true);
        if (!response.ok) {
            await copyMessage();
        }

        return new Response('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        return new Response('Internal Server Error', {status: 500});
    }
}

export async function handleRequest(request, config = {}) {
    config = config || {};

    const {
        prefix = 'public',
        secretToken,
        blocklist,
        blacklist,
        blacklistStore,
        blocklistStore,
        blockStore,
        storage,
        store,
        kv,
        stateStore,
        state
    } = config;
    const configuredBlocklist = resolveBlocklistStore(
        blocklist || blacklist || blacklistStore || blocklistStore || blockStore || storage || store || kv || stateStore || state
    );

    const url = new URL(request.url);
    const path = url.pathname;

    const INSTALL_PATTERN = new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`);
    const UNINSTALL_PATTERN = new RegExp(`^/${prefix}/uninstall/([^/]+)$`);
    const WEBHOOK_PATTERN = new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`);

    let match;

    if (match = path.match(INSTALL_PATTERN)) {
        return handleInstall(request, match[1], match[2], prefix, secretToken);
    }

    if (match = path.match(UNINSTALL_PATTERN)) {
        return handleUninstall(match[1]);
    }

    if (match = path.match(WEBHOOK_PATTERN)) {
        return handleWebhook(request, match[1], match[2], secretToken, configuredBlocklist);
    }

    return new Response('Not Found', {status: 404});
}
