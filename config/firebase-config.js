import admin from 'firebase-admin';
import 'dotenv/config';

// Initialize the Firebase Admin SDK if it hasn't been already
if (!admin.apps.length) {
    const firebaseServiceAccountString = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
    
    if (!firebaseServiceAccountString) {
        // This error should stop your server if the critical key is missing
        throw new Error('FIREBASE_ADMIN_SERVICE_ACCOUNT is not set in environment variables');
    }

    try {
        // Parse the JSON string from the environment variable
        const serviceAccount = JSON.parse(firebaseServiceAccountString);
        
        // Replace escaped newlines with actual newlines in the private_key field
        // This is necessary because environment variables often escape newlines.
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });

        console.log('✅ Firebase Admin SDK initialized successfully.');
    } catch (error) {
        console.error('❌ Error initializing Firebase Admin SDK:', error);
        throw new Error('Failed to parse or initialize service account credentials.');
    }
}

// Export initialized services
const db = admin.firestore();
export { admin, db };


// --- FCM Notification Logic ---

/**
 * Sends a push notification to a single device using its FCM token.
 * This function should be called from your backend route/service whenever a post is liked/commented.
 * * @param recipientToken The FCM token of the user's device (retrieved and saved from the frontend).
 * @param notificationDetails Details about the activity (e.g., title, body, post ID).
 */
export const sendActivityNotification = async (
    recipientToken, 
    notificationDetails // { title: string, body: string, postId: string }
) => {
    // The message structure for FCM
    const message = {
        // The 'notification' payload is handled by the OS/browser when the app is in the background.
        notification: {
            title: notificationDetails.title,
            body: notificationDetails.body,
        },
        // The 'data' payload is custom key/value pairs used for app logic/deep linking.
        data: {
            postId: notificationDetails.postId,
            type: 'post_activity', 
            // Stringify complex objects if needed, as data values must be strings
        },
        token: recipientToken,
    };

    try {
        // Send the message
        const response = await admin.messaging().send(message);
        console.log('Successfully sent FCM message:', response);
        return response;
    } catch (error) {
        console.error('Error sending push notification:', error);
        // You might want to delete the token from the database if the error indicates it's invalid
        throw error;
    }
};