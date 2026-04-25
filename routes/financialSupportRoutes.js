import express from 'express';
import { admin } from '../config/firebase-config.js';
import verifyToken from '../middleware/auth.js'; // Assuming this middleware exists
import { notifyUser } from '../services/notificationService.js';

const router = express.Router();

/**
 * @route POST /api/financial-support/requests
 * @desc Submit a financial support request.
 * @access Private (requires authentication)
 */
router.post('/requests', verifyToken, async (req, res) => {
    try {
        // User details are now securely accessed from the request object
        // after being set by the verifyToken middleware.
        const userId = req.user.uid; 
        const userEmail = req.user.email;
        const { applicationId, universityName, notes, requestedAmount } = req.body;

        // Basic validation for required fields
        if (!applicationId || !universityName || !requestedAmount) {
            return res.status(400).json({ message: 'Missing required fields: applicationId, universityName, or requestedAmount.' });
        }

        // Validate and sanitize input
        const numericAmount = parseFloat(requestedAmount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({ message: 'Requested amount must be a positive number.' });
        }

        const newRequest = {
            userId,
            userEmail,
            applicationId,
            universityName,
            requestedAmount: numericAmount, // Use the sanitized value
            notes: notes || '',
            status: 'pending', // Initial status
            requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const docRef = await admin.firestore().collection('financial_support_requests').add(newRequest);

        const adminsSnapshot = await admin.firestore().collection('users').where('role', '==', 'admin').get();
        const adminNotifications = adminsSnapshot.docs.map((doc) =>
            notifyUser(doc.id, {
                senderId: userId,
                pushTitle: 'New Financial Support Request',
                pushBody: `${userEmail} requested financial support for ${universityName}.`,
                emailSubject: 'New Financial Support Request',
                emailHtml: `<p>${userEmail} requested financial support for ${universityName}.</p>`,
                pushUrl: '/admin',
                type: 'GENERAL',
                relatedEntityId: docRef.id,
                metadata: { requestType: 'financial_support', requestId: docRef.id },
            })
        );
        await Promise.allSettled(adminNotifications);

        res.status(201).json({
            message: 'Financial support request sent successfully.',
            requestId: docRef.id
        });
    } catch (error) {
        console.error('Error submitting financial support request:', error);
        res.status(500).json({ message: 'Server error: Failed to submit request.' });
    }
});

export default router;
