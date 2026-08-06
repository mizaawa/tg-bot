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
    async fetch(request, env, ctx) {
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
            secretToken
        };

        return handleRequest(request, config);
    }
};
