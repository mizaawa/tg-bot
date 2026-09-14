/**
 * Open Wegram Bot - Cloudflare Worker Entry Point
 * A two-way private messaging Telegram bot
 *
 * GitHub Repository: https://github.com/wozulong/open-wegram-bot
 */

import {handleRequest, jsonResponse} from './core.js';

export async function resolveSecretToken(binding) {
    if (typeof binding === 'string') {
        return binding;
    }

    if (binding && typeof binding.get === 'function') {
        return await binding.get();
    }

    return '';
}

export default {
    async fetch(request, env = {}, ctx) {
        env = env || {};

        let secretToken;
        try {
            secretToken = await resolveSecretToken(env.SECRET_TOKEN);
        } catch (error) {
            console.error('Failed to read SECRET_TOKEN:', error);
            return jsonResponse({
                success: false,
                message: 'Failed to read SECRET_TOKEN from the Cloudflare binding.'
            }, 500);
        }

        const config = {
            prefix: env.PREFIX || 'public',
            secretToken,
            // BLOCKLIST is a Cloudflare KV namespace binding. The aliases keep
            // existing deployments flexible while the documented name remains
            // BLOCKLIST.
            blocklist: [
                env.BLOCKLIST,
                env.BLACKLIST,
                env.BLOCKLIST_KV,
                env.BLACKLIST_KV,
                env.STATE_KV
            ]
                .find(binding => Array.isArray(binding) || (binding && typeof binding === 'object' && [
                    'get', 'put', 'has', 'set', 'add', 'isBlocked', 'contains', 'block', 'addBlocked'
                ].some(method => typeof binding[method] === 'function'))) || null
        };

        return handleRequest(request, config);
    }
};
