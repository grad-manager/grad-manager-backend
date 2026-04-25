import express from 'express';
import { admin } from '../config/firebase-config.js';
import verifyToken from '../middleware/auth.js'; 
import { notifyUser } from '../services/notificationService.js';
import { getEffectivePlan, isTrialActive } from '../utils/trial.js';

const router = express.Router();
const db = admin.firestore();

// Normalize plan string to canonical values
const normalizePlan = (plan) => {
    if (!plan) return 'Free';
    const p = String(plan).trim().toLowerCase();
    if (p === 'pro') return 'Pro';
    if (p === 'premium') return 'Pro';
    return 'Free';
};

// SOP limits by plan (from pricing): Free=0, Pro=3
const getSopLimit = (plan) => {
    const p = normalizePlan(plan);
    switch (p) {
        case 'Free':
            return 0;
        case 'Pro':
            return 3;
        default:
            return 0;
    }
};

// Note: We use the centralized notifyUser(...) to send emails/push and
// persist a notification document in Firestore.

// New: Route for a user to request an SOP session
router.post('/', verifyToken, async (req, res) => {
    const { applicationId } = req.body;
    const userId = req.user.uid;

    if (!applicationId) {
        // NOTE: The frontend logic allows for a null applicationId (general request),
        // but the backend validation here assumes the FE sends the selected ID (which can be null).
        // To align with the FE's structure:
        // if (applicationId === undefined) {
        //     return res.status(400).json({ message: 'Application ID or null is required.' });
        // }
    }

    try {
        // --- 1. ENFORCEMENT OF REQUEST LIMIT ---
        // Fetch user document and SOP request count concurrently
        const [userDoc, requestSnapshot] = await Promise.all([
            db.collection('users').doc(userId).get(),
            db.collection('sop_requests').where('userId', '==', userId).get(),
        ]);
        
        const user = userDoc.exists ? userDoc.data() : null;

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const currentRequestCount = requestSnapshot.docs.length;
        const userPlan = getEffectivePlan(user, { defaultPlan: 'Free', trialPlan: 'Pro' });
        const maxSopRequests = getSopLimit(userPlan);
        const trialActive = isTrialActive(user.trial);

        // If a user-specific remaining counter is set, prefer that (sopRequestsRemaining)
        // Convention: sopRequestsRemaining === -1 means unlimited; >=0 is remaining quota
        const remainingField = typeof user.sopRequestsRemaining === 'number' ? user.sopRequestsRemaining : null;

        // ENFORCEMENT: If remainingField exists, use it; otherwise use plan limit vs count
        if (!trialActive && remainingField !== null) {
            if (remainingField === 0) {
                return res.status(403).json({
                    message: `You must upgrade to submit SOP requests.`,
                    code: 'LIMIT_EXCEEDED',
                    upgradeRequired: true,
                    nextPlan: 'Pro'
                });
            }
            // remainingField === -1 => unlimited, allow
        } else if (!trialActive) {
            // Check if user has reached their plan limit (when no per-user counter exists)
            if (maxSopRequests !== Infinity && currentRequestCount >= maxSopRequests) {
                return res.status(403).json({
                    message: `You have reached your limit of ${maxSopRequests} SOP request(s) on your ${normalizePlan(userPlan)} plan. Upgrade to Pro to submit more.`,
                    code: 'LIMIT_EXCEEDED',
                    upgradeRequired: true,
                    nextPlan: 'Pro'
                });
            }
        }
        // ----------------------------------------


        // Find the user's name
        const userName = user.name || 'A user';

        // Find the admin user ID
        const adminSnapshot = await db.collection('users').where('role', '==', 'admin').limit(1).get();
        const adminId = adminSnapshot.docs[0]?.id;

        if (!adminId) {
            // Log to console but still allow the request to proceed (though admin notification will fail)
            console.warn('Admin user not found. SOP request submitted but notification skipped.');
        }

        // Create the SOP request document and update user's counters atomically
        const batch = db.batch();

        const newRequestRef = db.collection('sop_requests').doc();
        batch.set(newRequestRef, {
            userId,
            applicationId: applicationId || null,
            status: 'pending',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Update user doc: increment sopRequestCount and decrement sopRequestsRemaining when applicable
        const userRef = db.collection('users').doc(userId);

        const userUpdates = {
            sopRequestCount: admin.firestore.FieldValue.increment(1),
        };

        if (typeof user.sopRequestsRemaining === 'number') {
            // If -1 => unlimited, don't decrement
            if (user.sopRequestsRemaining > 0) {
                userUpdates.sopRequestsRemaining = admin.firestore.FieldValue.increment(-1);
            }
        }

        batch.update(userRef, userUpdates);

        await batch.commit();

        // Notify the admin (creates Firestore notification + attempts push/email)
        if (adminId) {
            const message = `A new SOP writing request has been submitted by ${userName}. Request count: ${currentRequestCount + 1}.`;
            await notifyUser(adminId, {
                senderId: userId,
                pushTitle: 'New SOP Request',
                pushBody: message,
                emailSubject: 'New SOP request submitted',
                emailHtml: `<p>${message}</p>`,
                type: 'sop_request_received',
            });
        }

        res.status(201).json({ 
            message: 'SOP request submitted successfully.', 
            requestId: newRequestRef.id 
        });
    } catch (error) {
        console.error('Error submitting SOP request:', error);
        // Ensure the error response includes the custom code if it came from the limit check
        if (error.code === 'LIMIT_EXCEEDED') {
            return res.status(403).json({ message: error.message, code: 'LIMIT_EXCEEDED' });
        }
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// New: Route for admin to update the status of an SOP session (Unchanged)
router.put('/:requestId/status', verifyToken, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: Only administrators can update request status.' });
    }

    const { requestId } = req.params;
    const { status, details } = req.body;

    if (!status) {
        return res.status(400).json({ message: 'Status is required.' });
    }

    try {
        const requestRef = db.collection('sop_requests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists) {
            return res.status(404).json({ message: 'SOP request not found.' });
        }

        const requestData = requestDoc.data();
        const userId = requestData.userId;
        let updateData = { status, timestamp: admin.firestore.FieldValue.serverTimestamp() };

        let notificationMessage = '';
        let notificationType = 'sop_request_status_update';
        let applicationName = '';

        // Fetch application details for the notification message
        const appDoc = await db.collection('applications').doc(requestData.applicationId).get();
        if (appDoc.exists) {
            applicationName = appDoc.data().schoolName || 'an application';
        }

        switch (status) {
            case 'accepted':
                updateData.acceptanceDetails = details;
                notificationMessage = `Your SOP request for ${applicationName} has been accepted.`;
                break;
            case 'declined':
                updateData.declineReason = details.reason;
                notificationMessage = `Your SOP request for ${applicationName} has been declined.`;
                break;
            case 'rescheduled':
                updateData.rescheduleDetails = details;
                notificationMessage = `Your SOP request for ${applicationName} has been rescheduled.`;
                break;
            case 'completed':
                notificationMessage = `Your SOP session for ${applicationName} has been completed.`;
                break;
            case 'not completed':
                updateData.uncompletionReason = details.reason;
                notificationMessage = `Your SOP session for ${applicationName} was not completed.`;
                break;
            default:
                return res.status(400).json({ message: 'Invalid status provided.' });
        }

        await requestRef.update(updateData);
        // Notify the user about status change (push + email + firestore doc)
        await notifyUser(userId, {
            senderId: req.user.uid,
            pushTitle: 'SOP Request Update',
            pushBody: notificationMessage,
            emailSubject: 'Update on your SOP request',
            emailHtml: `<p>${notificationMessage}</p>`,
            type: notificationType,
        });

        res.status(200).json({ message: 'SOP request status updated successfully.' });
    } catch (error) {
        console.error('Error updating SOP request status:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

export default router;
