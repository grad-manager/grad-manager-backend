// src/routes/visaInterviewPrepRoutes.js

import express from 'express';
import { admin } from '../config/firebase-config.js';
import { notifyUser } from '../services/notificationService.js';

const router = express.Router();

// Route to handle visa interview prep requests
router.post('/requests', async (req, res) => {
    try {
        return res.status(403).json({
            message: 'Mock interview preparation is no longer included in the current plans.',
            code: 'PLAN_NOT_ELIGIBLE',
            upgradeRequired: false,
        });

        const userId = (req.user && req.user.uid) || req.body.userId;
        const userEmail = (req.user && req.user.email) || req.body.userEmail;
        const { country, embassy, visaType, interviewDate, notes } = req.body;

        // Basic validation for required fields
        if (!userId || !userEmail || !country || !embassy || !visaType || !interviewDate) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        const newRequest = {
            userId,
            userEmail,
            country,
            embassy,
            visaType,
            interviewDate,
            notes: notes || '',
            status: 'pending',
            requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const docRef = await admin.firestore().collection('visa_interview_prep_requests').add(newRequest);

        const adminsSnapshot = await admin.firestore().collection('users').where('role', '==', 'admin').get();
        const adminNotifications = adminsSnapshot.docs.map((doc) =>
            notifyUser(doc.id, {
                senderId: userId,
                pushTitle: 'New Visa Prep Request',
                pushBody: `${userEmail} requested visa prep for ${visaType} (${country}).`,
                emailSubject: 'New Visa Prep Request',
                emailHtml: `<p>${userEmail} requested visa prep for ${visaType} (${country}).</p>`,
                pushUrl: '/admin',
                type: 'GENERAL',
                relatedEntityId: docRef.id,
                metadata: { requestType: 'visa_prep', requestId: docRef.id },
            })
        );
        await Promise.allSettled(adminNotifications);

        res.status(201).json({
            message: 'Visa interview prep request sent successfully.',
            requestId: docRef.id
        });
    } catch (error) {
        console.error('Error submitting visa interview prep request:', error);
        res.status(500).json({ message: 'Server error: Failed to submit request.' });
    }
});

export default router;
