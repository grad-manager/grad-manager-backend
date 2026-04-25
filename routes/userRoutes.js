// This is an example, your file structure may be different.
// The core logic is to correctly handle the new request body.

import express from 'express';
import { db } from '../config/firebase-config.js';

const router = express.Router();

// PUT /api/users/:uid/notifications
// Updates a user's notification preferences in Firestore
router.put('/:uid/notifications', async (req, res) => {
    const { uid } = req.params;
    
    // CORRECTED: Destructure the new notificationSettings object from the request body
    const { notificationSettings } = req.body;

    // Optional: Add validation for the new structure
    if (!notificationSettings || typeof notificationSettings.email !== 'boolean' || typeof notificationSettings.push !== 'boolean') {
        return res.status(400).json({ error: 'Invalid input for notification settings. Expected { email: boolean, push: boolean }.' });
    }

    try {
        const userRef = db.collection('users').doc(uid);

        // CORRECTED: Use set() with the entire notificationSettings object
        await userRef.set({
            notificationSettings: notificationSettings
        }, { merge: true });

        res.status(200).json({ message: 'Notification settings updated successfully.' });
    } catch (error) {
        console.error('Error updating notification settings:', error);
        res.status(500).json({ error: 'Failed to update notification settings.' });
    }
});

export default router;