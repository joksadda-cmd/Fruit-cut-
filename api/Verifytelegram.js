const crypto = require('crypto');

/**
 * Verifies Telegram WebApp initData signature.
 * Call this in every API handler before processing.
 *
 * @param {string} initData  - value of tg.initData from the frontend
 * @param {string} botToken  - your Telegram Bot token (from env)
 * @returns {boolean}
 */
function verifyTelegramData(initData, botToken) {
    if (!initData || !botToken) return false;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;
        params.delete('hash');

        const checkString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();

        const expectedHash = crypto
            .createHmac('sha256', secretKey)
            .update(checkString)
            .digest('hex');

        return hash === expectedHash;
    } catch (e) {
        console.error('Telegram verify error:', e);
        return false;
    }
}

module.exports = { verifyTelegramData };
