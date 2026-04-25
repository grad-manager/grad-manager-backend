// functions/src/config/webpushConfigFunctions.js
const webpush = require("web-push");
const functions = require('firebase-functions'); // Use require for JS

// Retrieve VAPID keys from the secure Firebase Functions config
const VAPID_PUBLIC_KEY = functions.config().webpush.public_key;
const VAPID_PRIVATE_KEY = functions.config().webpush.private_key;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error("CRITICAL: VAPID keys not configured. Use 'firebase functions:config:set webpush.public_key=...'.");
} else {
    webpush.setVapidDetails(
        "mailto:admin@gradmanagers.com",
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
}

module.exports = webpush;