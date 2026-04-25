// src/routes/interviewPrepRoutes.js

import express from 'express';
import { admin } from '../config/firebase-config.js';
import { notifyUser } from '../services/notificationService.js';
import { getEffectivePlan } from '../utils/trial.js';

const router = express.Router();

// Normalize plan string to canonical values
const normalizePlan = (plan) => {
    if (!plan) return 'Free';
    const p = String(plan).trim().toLowerCase();
    if (p === 'pro') return 'Pro';
    if (p === 'premium') return 'Pro';
    return 'Free';
};

const getInterviewLimit = () => 0;

// Route to handle interview prep requests
router.post('/requests', async (req, res) => {
    try {
        // Prefer authenticated user information when available (index mounts route with verifyToken)
        const userIdFromBody = req.body.userId;
        const userEmailFromBody = req.body.userEmail;
        const userId = (req.user && req.user.uid) || userIdFromBody;
        const userEmail = (req.user && req.user.email) || userEmailFromBody;
        const { applicationId, schoolName, programName, interviewDate, notes } = req.body;

        // Basic validation
        if (!userId || !userEmail || !applicationId || !schoolName || !programName || !interviewDate) {
            return res.status(400).json({ message: 'Missing required fields.' });
        }

        // Fetch user profile to determine plan
        const userDoc = await admin.firestore().collection('users').doc(userId).get();
        const user = userDoc.exists ? userDoc.data() : null;
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const userPlan = getEffectivePlan(user, { defaultPlan: 'Free', trialPlan: 'Pro' });
        const maxInterviewRequests = getInterviewLimit(userPlan);

        // Count existing interview prep requests for this user
        const existingSnapshot = await admin.firestore().collection('interview_prep_requests')
            .where('userId', '==', userId)
            .get();
        const currentCount = existingSnapshot.size;

        // Plan gating
        if (maxInterviewRequests === 0) {
            return res.status(403).json({
                message: 'Mock interview preparation is no longer included in the current plans.',
                code: 'PLAN_NOT_ELIGIBLE',
                upgradeRequired: false,
                nextPlan: null
            });
        }

        if (currentCount >= maxInterviewRequests) {
            return res.status(403).json({
                message: `You have reached your mock interview limit of ${maxInterviewRequests} session(s).`,
                code: 'LIMIT_EXCEEDED',
                upgradeRequired: true,
                nextPlan: 'Pro'
            });
        }

        const newRequest = {
            userId,
            userEmail,
            applicationId,
            schoolName,
            programName,
            interviewDate,
            notes: notes || '',
            status: 'pending',
            requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Create request and increment mockInterviewCount atomically
        const batch = admin.firestore().batch();
        const newDocRef = admin.firestore().collection('interview_prep_requests').doc();
        batch.set(newDocRef, newRequest);
        const userRef = admin.firestore().collection('users').doc(userId);
        batch.update(userRef, {
            mockInterviewCount: admin.firestore.FieldValue.increment(1)
        });

        await batch.commit();

        const adminsSnapshot = await admin.firestore().collection('users').where('role', '==', 'admin').get();
        const adminNotifications = adminsSnapshot.docs.map((doc) =>
            notifyUser(doc.id, {
                senderId: userId,
                pushTitle: 'New Interview Prep Request',
                pushBody: `${userEmail} requested interview prep for ${schoolName} (${programName}).`,
                emailSubject: 'New Interview Prep Request',
                emailHtml: `<p>${userEmail} requested interview prep for ${schoolName} (${programName}).</p>`,
                pushUrl: '/admin',
                type: 'GENERAL',
                relatedEntityId: newDocRef.id,
                metadata: { requestType: 'interview_prep', requestId: newDocRef.id },
            })
        );
        await Promise.allSettled(adminNotifications);

        res.status(201).json({
            message: 'Interview prep request sent successfully.',
            requestId: newDocRef.id
        });
    } catch (error) {
        console.error('Error submitting interview prep request:', error);
        res.status(500).json({ message: 'Server error: Failed to submit request.' });
    }
});

export default router;
