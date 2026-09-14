/**
 * Open Wegram Bot - Core Logic
 * Shared code between Cloudflare Worker and Vercel deployments
 */

import {addBlocked, isBlocked, resolveBlocklistStore} from './blocklist.js';

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

async function answerCallbackQuery(botToken, callbackQueryId, text) {
    if (!callbackQueryId) {
        return;
    }

    try {
        const body = {callback_query_id: callbackQueryId};
        if (text) {
            body.text = text;
        }
        await postToTelegramApi(botToken, 'answerCallbackQuery', body);
    } catch (error) {
        // A callback answer is cosmetic. Do not turn a successfully persisted
        // block into a webhook retry when Telegram is temporarily unavailable.
        console.error('Error answering callback query:', error);
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
        await answerCallbackQuery(botToken, callbackQuery && callbackQuery.id, '无权操作');
        return new Response('OK');
    }

    const data = callbackQuery.data === undefined || callbackQuery.data === null ? '' : String(callbackQuery.data);
    const match = data.match(/^block:(-?\d+)$/);
    if (!match) {
        // The first sender button used raw numeric callback data in older
        // forwarded messages. Keep those callbacks inert and silent.
        if (/^-?\d+$/.test(data)) {
            await answerCallbackQuery(botToken, callbackQuery.id);
            return new Response('OK');
        }
        await answerCallbackQuery(botToken, callbackQuery.id, '无效的操作');
        return new Response('OK');
    }

    try {
        await addBlocked(blocklist, ownerUid, match[1], botToken);
    } catch (error) {
        console.error('Error saving blocked account:', error);
        await answerCallbackQuery(botToken, callbackQuery.id, '暂时无法拉黑，请稍后重试');
        return new Response('OK');
    }

    await answerCallbackQuery(botToken, callbackQuery.id, '已拉黑此账号');

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

        if (!message.chat || message.chat.id === undefined || message.chat.id === null) {
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
                    text: '🚫 拉黑此账号',
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
