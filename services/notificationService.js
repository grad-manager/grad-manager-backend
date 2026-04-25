import { admin } from '../config/firebase-config.js';
import { sendGeneralEmail } from './sendGridService.js';
import webpush from '../webpushSetup.js';

const db = admin.firestore();

const resolvePushBaseUrl = () => {
    const envBase = process.env.CLIENT_URL || process.env.FRONTEND_URL || process.env.SITE_URL;
    if (envBase) {
        return envBase.startsWith('http://') || envBase.startsWith('https://')
            ? envBase
            : `https://${envBase}`;
    }
    if (process.env.NODE_ENV === 'production') {
        return 'https://www.gradmanagers.com';
    }
    return 'http://localhost:5173';
};

const normalizePushUrl = (rawUrl) => {
    const baseUrl = resolvePushBaseUrl();
    const fallbackUrl = new URL('/', baseUrl);

    try {
        const parsed = new URL(rawUrl || '/', baseUrl);

        if (process.env.NODE_ENV === 'production' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
            const base = new URL(baseUrl);
            parsed.protocol = base.protocol;
            parsed.host = base.host;
        }

        return parsed.toString();
    } catch (error) {
        return fallbackUrl.toString();
    }
};

/**
 * Send notification to a user via Email and Push (if subscribed).
 * Also creates a notification document in Firestore for UI listing.
 * @param {string} userId - Firestore user document ID
 * @param {object} opts
 * @param {string} [opts.emailSubject]
 * @param {string} [opts.emailHtml]
 * @param {string} [opts.pushTitle]
 * @param {string} [opts.pushBody]
 * @param {string} [opts.pushUrl]
 * @param {string} [opts.type]
 */
export const notifyUser = async (userId, opts = {}) => {
    try {
        const userRef = db.collection('users').doc(String(userId));
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            console.warn(`[notifyUser] User ${userId} not found in Firestore.`);
            return;
        }

        const user = userDoc.data();
        const email = user.email;

        // 1) Create a notification document for UI
        try {
            await db.collection('notifications').add({
                recipientId: userId,
                senderId: opts.senderId || null,
                message: opts.pushBody || opts.emailSubject || opts.emailHtml || 'You have a new notification.',
                type: opts.type || 'general',
                read: false,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                relatedEntityId: opts.relatedEntityId || opts.metadata?.relatedEntityId || null,
                url: opts.pushUrl || opts.metadata?.url || null,
                metadata: opts.metadata || null,
            });
        } catch (err) {
            console.error('[notifyUser] Failed to create notification document:', err.message || err);
        }

        // 2) Send Email (if available and requested)
        if (email && opts.emailSubject && opts.emailHtml) {
            try {
                await sendGeneralEmail(email, opts.emailSubject, opts.emailHtml);
            } catch (err) {
                console.error(`[notifyUser] Failed to send email to ${email}:`, err.message || err);
            }
        }

        // 3) Send Push Notification (if subscription exists and push content provided)
        if (opts.pushTitle || opts.pushBody) {
            try {
                const subDoc = await db.collection('subscriptions').doc(String(userId)).get();
                if (subDoc.exists) {
                    const subscription = subDoc.data();
                    const pushTargetUrl = normalizePushUrl(opts.pushUrl || opts.metadata?.url);
                    const payload = JSON.stringify({
                        title: opts.pushTitle || 'Notification',
                        options: {
                            body: opts.pushBody || '',
                            icon: opts.icon || '/icons/icon-192x192.png',
                            data: {
                                ...opts.metadata,
                                url: pushTargetUrl,
                                timestamp: Date.now(),
                            },
                        }
                    });

                    try {
                        await webpush.sendNotification(subscription, payload);
                    } catch (err) {
                        console.error('[notifyUser] Push send error:', err.statusCode || err.message || err);
                        // Clean up expired subscriptions
                        if (err.statusCode === 410 || err.statusCode === 404) {
                            await db.collection('subscriptions').doc(String(userId)).delete();
                        }
                    }
                } else {
                    // No subscription document for user
                }
            } catch (err) {
                console.error('[notifyUser] Error checking subscription:', err.message || err);
            }
        }

    } catch (error) {
        console.error('[notifyUser] Unexpected error:', error.message || error);
    }
};

export default { notifyUser };
