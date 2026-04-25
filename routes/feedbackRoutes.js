// ./routes/feedbackRoutes.js

import express from 'express';
import verifyToken from '../middleware/auth.js';
import checkRole from '../middleware/checkRole.js';
import { admin } from '../config/firebase-config.js'; // Firestore admin instance
import { notifyUser } from '../services/notificationService.js';
const db = admin.firestore();
const router = express.Router();

/**
 * Utility to find all Admin UIDs
 */
const getAdminUids = async () => {
    // Assumption: Admins have a 'role' field set to 'admin' in the 'users' collection.
    const adminSnapshot = await db.collection('users').where('role', '==', 'admin').get();
    return adminSnapshot.docs.map(doc => doc.id);
};

/**
 * @route POST /api/feedback
 * @desc Allow users to submit feedback and trigger Admin notifications
 * @access Private (logged-in users)
 */
router.post('/', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { feedback, email } = req.body;

        if (!feedback || feedback.trim().length < 5) {
            return res.status(400).json({ message: 'Feedback must be at least 5 characters long.' });
        }

        // 1. Fetch user data to use in the notification message
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.exists ? userDoc.data() : { firstName: 'A user' };
        const userName = userData.firstName || 'A user';

        const feedbackData = {
            feedback: feedback.trim(),
            email: email?.trim() || null,
            submittedBy: userId,
            submittedAt: admin.firestore.FieldValue.serverTimestamp(),
            // Adding a status field for admin tracking
            status: 'new', 
        };

        const docRef = await db.collection('userFeedback').add(feedbackData);
        
        // --- 🏆 NEW: Admin Notification Logic ---
        
        const adminUids = await getAdminUids();

        const notificationMessage = `🔔 New Feedback from ${userName}: "${feedback.substring(0, 50)}${feedback.length > 50 ? '...' : ''}"`;
        
        const notificationPromises = adminUids.map(adminId => (
            notifyUser(adminId, {
                senderId: userId,
                pushTitle: 'New Feedback',
                pushBody: notificationMessage,
                emailSubject: 'New Feedback Submitted',
                emailHtml: `<p>${notificationMessage}</p>`,
                pushUrl: `/admin?tab=userFeedback&feedbackId=${docRef.id}`,
                type: 'admin_new_feedback',
                relatedEntityId: docRef.id,
                metadata: { feedbackId: docRef.id },
            })
        ));

        await Promise.allSettled(notificationPromises);
        
        // ----------------------------------------

        res.status(201).json({
            message: 'Feedback submitted successfully.',
            id: docRef.id,
        });
    } catch (error) {
        console.error('Error submitting feedback and creating notification:', error);
        res.status(500).json({ message: 'Failed to submit feedback.' });
    }
});

/**
 * @route GET /api/feedback
 * @desc Admin fetch all feedbacks with user info
 * @access Private (admin only)
 */
router.get('/', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const snapshot = await db.collection('userFeedback')
            .orderBy('submittedAt', 'desc')
            .get();

        const feedbacks = await Promise.all(snapshot.docs.map(async docSnap => {
            const data = docSnap.data();
            let userName = 'N/A';
            let userEmail = data.email || 'N/A';

            // Fetch user info from 'users' collection
            try {
                const userDoc = await db.collection('users').doc(data.submittedBy).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    // Using full name (or just first name if full name not stored)
                    userName = userData?.firstName || 'N/A'; 
                    userEmail = userData?.email || userEmail;
                }
            } catch (err) {
                console.error(`Error fetching user info for ${data.submittedBy}:`, err);
            }

            return {
                id: docSnap.id,
                feedback: data.feedback,
                submittedBy: data.submittedBy,
                name: userName, // use firstName
                email: userEmail,
                submittedAt: data.submittedAt?.toDate?.().toISOString() || null,
                status: data.status || 'new', // Include status
            };
        }));

        res.status(200).json(feedbacks);
    } catch (error) {
        console.error('Error fetching feedback:', error);
        res.status(500).json({ message: 'Failed to retrieve feedback.' });
    }
});

export default router;
