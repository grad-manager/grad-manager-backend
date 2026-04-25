// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const webpush = require('./src/config/webpushConfigFunctions'); // Require the configured webpush utility

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// =========================================================================
// 1. HTTPS Function: POST /push/subscribe (Saves subscription from client)
// =========================================================================

exports.subscribe = functions.https.onRequest(async (req, res) => {
    // CORS setup (crucial for client-side fetch calls)
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }
    
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    // Authenticate User via ID Token
    const authHeader = req.headers.authorization;
    const idToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;

    if (!idToken) {
        return res.status(401).send({ error: 'Unauthorized: Missing token.' });
    }

    let userId;
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        userId = decodedToken.uid;
    } catch (error) {
        console.error('Token verification failed:', error);
        return res.status(403).send({ error: 'Forbidden: Invalid token.' });
    }
    
    // Validate and Save Subscription Data
    const subscription = req.body; 

    if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).send({ error: 'Invalid push subscription data.' });
    }

    try {
        await db.collection('subscriptions').doc(userId).set({
            ...subscription,
            userId: userId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        console.log(`Subscription saved for user: ${userId}`);
        return res.status(201).send({ message: 'Push subscription saved successfully.' });
    } catch (error) {
        console.error('Failed to save subscription:', error);
        return res.status(500).send({ error: 'Failed to process subscription request.' });
    }
});


// =========================================================================
// 2. Firestore Trigger: onPostLiked (Sends notification when a like is created)
// =========================================================================

exports.onPostLiked = functions.firestore
    .document('posts/{postId}/likes/{likerId}')
    .onCreate(async (likeSnap, context) => {
        const { postId, likerId } = context.params;
        
        // 1. Fetch the main Post document
        const postSnap = await db.doc(`posts/${postId}`).get();

        if (!postSnap.exists) return null;

        const postData = postSnap.data();
        const postOwnerId = postData && postData.userId;
        
        // Safety Checks
        if (!postOwnerId || postOwnerId === likerId) {
            return null;
        }
        
        // 2. Check Post Owner's Profile and Settings
        const ownerProfileSnap = await db.doc(`users/${postOwnerId}`).get();
        const ownerData = ownerProfileSnap.data();

        if (!ownerData || ownerData.notificationSettings?.push !== true) {
             return null;
        }

        // 3. Fetch the Push Subscription data
        const subscriptionSnap = await db.doc(`subscriptions/${postOwnerId}`).get();
        const subscriptionData = subscriptionSnap.data();
        
        if (!subscriptionData) {
             return null;
        }
        
        // 4. Determine the liker's name
        const likerProfileSnap = await db.doc(`users/${likerId}`).get();
        const likerName = likerProfileSnap.data() 
            ? (`${likerProfileSnap.data().firstName || ''} ${likerProfileSnap.data().lastName || 'User'}`).trim()
            : 'Someone';

        // 5. Construct and Send the push notification payload
        const postTitle = postData.title || 'a post';
        const payload = JSON.stringify({
            title: '💖 New Post Like!',
            body: `${likerName} liked your post: "${postTitle.substring(0, 50)}${postTitle.length > 50 ? '...' : ''}"`,
            icon: '/icon-192.png',
            data: { 
                url: `/community/${postId}` 
            }
        });
        
        try {
            await webpush.sendNotification(subscriptionData, payload);
            console.log(`Sent 'like' notification to user: ${postOwnerId}`);
        } catch (error) {
            if (error.statusCode === 410) { // 410 Gone means subscription expired
                 await db.doc(`subscriptions/${postOwnerId}`).delete();
                 console.warn(`Deleted expired subscription for user ${postOwnerId}.`);
            } else {
                 console.error(`Error sending push notification to ${postOwnerId}:`, error);
            }
        }

        return null;
    });