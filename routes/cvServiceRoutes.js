// routes/cvServiceRoutes.js 

import express from 'express';
import admin from 'firebase-admin';
import verifyToken from '../middleware/auth.js';
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { v2 as cloudinary } from 'cloudinary';
import { notifyUser } from '../services/notificationService.js';
import { getEffectivePlan } from '../utils/trial.js';

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

// CV review limits by plan (from pricing: Free=0, Pro=3)
const getCvLimit = (plan) => {
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

// Cloudinary config (must be configured at the top of the file)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Cloudinary storage setup for initial CV uploads
const initialCVStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: (req, file) => {
        const userId = req.user.uid;
        return {
            folder: `grad-tracker/initial-cvs/${userId}`,
            public_id: `initial-cv-${userId}-${Date.now()}`,
            resource_type: 'raw',
            format: file.mimetype.split('/')[1],
        };
    },
});
const uploadInitialCV = multer({ storage: initialCVStorage });

// Cloudinary storage setup for corrected CV uploads
const correctedCVStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: (req, file) => {
        const requestId = req.params.requestId;
        return {
            folder: `grad-tracker/corrected-cvs`,
            public_id: `corrected-cv-${requestId}-${Date.now()}`,
            resource_type: 'raw',
            format: file.mimetype.split('/')[1],
        };
    },
});
const uploadCorrectedCV = multer({ storage: correctedCVStorage });

// ** ACADEMIC CV SERVICE ROUTES **

// Route to submit a new CV upload request (UPDATED to include notes and plan checks)
router.post('/submit', verifyToken, uploadInitialCV.single('cvFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded. Please submit a CV.' });
        }
        
        const userId = req.user.uid;
        const userEmail = req.user.email;
        const { notes } = req.body; // Extract optional notes

        // 🆕 PLAN CHECK: Fetch user and verify CV review limit
        const userDoc = await db.collection('users').doc(userId).get();
        const user = userDoc.exists ? userDoc.data() : null;

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const userPlan = getEffectivePlan(user, { defaultPlan: 'Free', trialPlan: 'Pro' });
        const cvLimit = getCvLimit(userPlan);

        // Check if user's plan allows CV reviews
        if (cvLimit === 0) {
            return res.status(403).json({
                message: 'Your Free plan does not include CV review services. Upgrade to Pro to submit a CV.',
                code: 'PLAN_NOT_ELIGIBLE',
                upgradeRequired: true,
                nextPlan: 'Pro'
            });
        }

        // Check if user already has a pending CV review
        const existingRequest = await db.collection('cv_requests')
            .where('userId', '==', userId)
            .where('status', 'in', ['pending', 'scheduled'])
            .limit(1)
            .get();

        if (!existingRequest.empty) {
            return res.status(409).json({ message: 'You already have a pending CV review request.' });
        }

        // Create CV request and increment cvRequestCount atomically
        const batch = db.batch();
        
        const cvRequestsRef = db.collection('cv_requests');
        const newRequestDoc = cvRequestsRef.doc();
        
        batch.set(newRequestDoc, {
            userId,
            userEmail,
            cvUrl: req.file.path,
            notes: notes || '', // Save notes
            status: 'pending',
            type: 'cv_upload',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Increment cvRequestCount in user document
        const userRef = db.collection('users').doc(userId);
        batch.update(userRef, {
            cvRequestCount: admin.firestore.FieldValue.increment(1)
        });

        await batch.commit();

        const adminsSnapshot = await db.collection('users').where('role', '==', 'admin').get();
        const adminNotifications = adminsSnapshot.docs.map((doc) =>
            notifyUser(doc.id, {
                senderId: userId,
                pushTitle: 'New CV Review Request',
                pushBody: `${userEmail} submitted a CV review request.`,
                emailSubject: 'New CV Review Request',
                emailHtml: `<p>${userEmail} submitted a CV review request.</p>`,
                pushUrl: '/admin',
                type: 'GENERAL',
                relatedEntityId: newRequestDoc.id,
                metadata: { requestType: 'cv_review', requestId: newRequestDoc.id },
            })
        );
        await Promise.allSettled(adminNotifications);

        res.status(201).json({
            message: 'Academic CV service request submitted successfully.',
            requestId: newRequestDoc.id,
            cvUrl: req.file.path
        });
    } catch (error) {
        console.error('Error submitting CV service request:', error);
        res.status(500).json({ message: 'Server error: Failed to submit request.' });
    }
});// Route for users to check their request status (CRITICALLY UPDATED FOR FRONTEND MAPPING)
router.get('/my-request', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        
        const userRequestSnapshot = await db.collection('cv_requests')
            .where('userId', '==', userId)
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();

        if (userRequestSnapshot.empty) {
            return res.status(200).json({ status: 'none', message: 'No CV request found.' });
        }

        const doc = userRequestSnapshot.docs[0];
        const data = doc.data();

        // Check for corrupt data (optional safety check)
        if (!data) {
            return res.status(200).json({ status: 'error', message: 'Request data found but is corrupt.' });
        }

        res.status(200).json({
            id: doc.id,
            status: data.status,
            // FIX 1: Map createdAt (Firestore Timestamp) to 'timestamp' (string) for date display.
            timestamp: data.createdAt?.toDate().toISOString() || data.updatedAt?.toDate().toISOString(), 
            
            // FIX 2: Map cvUrl (DB field for original file) to uploadedFileUrl (Frontend expected)
            uploadedFileUrl: data.cvUrl || null, 
            
            // FIX 3: Map correctedCvUrl (DB field for final file) to finalDocumentUrl (Frontend expected)
            finalDocumentUrl: data.correctedCvUrl || null, 
            
            // Ensure type is included, as it's critical for frontend logic
            type: data.type || 'cv_upload', 
            
            mentorFeedback: data.mentorFeedback || null, // Mentor's final feedback
            notes: data.notes || null, // User's initial notes
            // Scheduled session details (still useful for the user view)
            scheduledDate: data.scheduledDate || null,
            scheduledTime: data.scheduledTime || null,
            zoomLink: data.zoomLink || null,
        });

    } catch (error) {
        console.error('Error fetching user\'s CV request:', error);
        res.status(500).json({ message: 'Failed to retrieve your request status.' });
    }
});

// Route for users to submit a new CV request with notes (No change needed)
router.post('/new-request', verifyToken, async (req, res) => {
    try {
        const { notes } = req.body;
        if (!notes) {
            return res.status(400).json({ message: 'Notes are required for this request type.' });
        }

        const userId = req.user.uid;
        const userEmail = req.user.email;

        const existingRequest = await db.collection('cv_requests')
            .where('userId', '==', userId)
            .where('status', 'in', ['pending', 'scheduled'])
            .limit(1)
            .get();

        if (!existingRequest.empty) {
            return res.status(409).json({ message: 'You already have a pending CV review request.' });
        }

        const newRequestDoc = await db.collection('cv_requests').add({
            userId,
            userEmail,
            notes,
            status: 'pending',
            type: 'new_cv_request',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const adminsSnapshot = await db.collection('users').where('role', '==', 'admin').get();
        const adminNotifications = adminsSnapshot.docs.map((doc) =>
            notifyUser(doc.id, {
                senderId: userId,
                pushTitle: 'New CV Request',
                pushBody: `${userEmail} submitted a CV request.`,
                emailSubject: 'New CV Request',
                emailHtml: `<p>${userEmail} submitted a CV request.</p>`,
                pushUrl: '/admin',
                type: 'GENERAL',
                relatedEntityId: newRequestDoc.id,
                metadata: { requestType: 'cv_request', requestId: newRequestDoc.id },
            })
        );
        await Promise.allSettled(adminNotifications);

        res.status(201).json({
            message: 'New CV request with notes submitted successfully.',
            requestId: newRequestDoc.id,
        });
    } catch (error) {
        console.error('Error submitting new CV request:', error);
        res.status(500).json({ message: 'Server error: Failed to submit new request.' });
    }
});

// ** ADMIN ROUTES **

// Route to get all CV review requests for admin dashboard (No change needed)
router.get('/admin/cv-service/all-reviews', verifyToken, async (req, res) => {
    try {
        // Check if the user is an admin
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (!userDoc.exists || userDoc.data().role !== 'admin') {
            return res.status(403).json({ message: 'Forbidden: Admin access required.' });
        }

        const requestsSnapshot = await db.collection('cv_requests')
            .orderBy('createdAt', 'desc')
            .get();
        
        const allRequests = requestsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate().toISOString(),
        }));
        res.status(200).json(allRequests);
    } catch (error) {
        console.error('Error fetching all CV requests:', error);
        res.status(500).json({ message: 'Server error: Failed to fetch requests.' });
    }
});

// ** REPLACING OLD /admin/cv-service/correct/:requestId **
// New route for admin to update status, upload corrected CV, and add mentor feedback
router.put('/admin/cv-service/update-review/:requestId', verifyToken, uploadCorrectedCV.single('correctedCV'), async (req, res) => {
    try {
        const { requestId } = req.params;
        const { status, mentorFeedback } = req.body; 

        // 1. Validate admin role
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (!userDoc.exists || userDoc.data().role !== 'admin') {
            return res.status(403).json({ message: 'Forbidden: Admin access required.' });
        }
        
        if (!status) {
            return res.status(400).json({ message: 'Status is required for review update.' });
        }

        const validFinalStatuses = ['completed', 'feedback'];
        const isFinalStatus = validFinalStatuses.includes(status);
        
        const requestRef = db.collection('cv_requests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists) {
            return res.status(404).json({ message: 'CV request not found.' });
        }

        let updateData = {
            status,
            mentorFeedback: mentorFeedback || null,
            reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Check for file upload
        if (req.file) {
            updateData.correctedCvUrl = req.file.path;
        }

        // CRITICAL: Enforce that a final document URL exists for final statuses
        if (isFinalStatus) {
            // Check if URL is in the update data OR already exists in the document
            if (!updateData.correctedCvUrl && !requestDoc.data().correctedCvUrl) {
                return res.status(400).json({ 
                    message: `A final corrected CV file must be uploaded or already linked to set status to '${status}'.` 
                });
            }
        }

        await requestRef.update(updateData);

        const requestData = requestDoc.data();
        const recipientId = requestData?.userId;
        if (recipientId) {
            const notificationType = isFinalStatus ? 'cv_review_complete' : 'cv_review_in_progress';
            const notificationMessage = isFinalStatus
                ? 'Your CV review is complete. You can now download the corrected version.'
                : 'Your CV review request has been updated by an admin.';

            await notifyUser(recipientId, {
                senderId: req.user.uid,
                pushTitle: 'CV Review Update',
                pushBody: notificationMessage,
                emailSubject: 'CV Review Update',
                emailHtml: `<p>${notificationMessage}</p>`,
                pushUrl: '/services/cv-review',
                type: notificationType,
                relatedEntityId: requestId,
                metadata: { requestId, status },
            });
        }

        res.status(200).json({ message: `CV request updated to '${status}' successfully.`, updateData });
    } catch (error) {
        console.error('Error updating CV review status:', error);
        res.status(500).json({ message: 'Server error: Failed to update review.' });
    }
});


// New route for admin to schedule a live session (No change needed)
router.post('/admin/cv-service/schedule-session/:requestId', verifyToken, async (req, res) => {
    try {
        const { requestId } = req.params;
        const { scheduledDate, scheduledTime, zoomLink } = req.body;

        // Validate admin role
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        if (!userDoc.exists || userDoc.data().role !== 'admin') {
            return res.status(403).json({ message: 'Forbidden: Admin access required.' });
        }

        if (!scheduledDate || !scheduledTime || !zoomLink) {
            return res.status(400).json({ message: 'Missing required scheduling information.' });
        }

        const requestRef = db.collection('cv_requests').doc(requestId);
        const requestDoc = await requestRef.get();
        
        if (!requestDoc.exists) {
            return res.status(404).json({ message: 'Request not found.' });
        }

        await requestRef.update({
            status: 'scheduled',
            scheduledDate,
            scheduledTime,
            zoomLink,
            reviewedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const recipientId = requestDoc.data()?.userId;
        if (recipientId) {
            await notifyUser(recipientId, {
                senderId: req.user.uid,
                pushTitle: 'CV Session Scheduled',
                pushBody: `Your CV review session is scheduled for ${scheduledDate} at ${scheduledTime}.`,
                emailSubject: 'CV Session Scheduled',
                emailHtml: `<p>Your CV review session is scheduled for ${scheduledDate} at ${scheduledTime}.</p>`,
                pushUrl: '/services/cv-review',
                type: 'cv_session_scheduled',
                relatedEntityId: requestId,
                metadata: { requestId, scheduledDate, scheduledTime, zoomLink },
            });
        }

        res.status(200).json({ message: 'Session scheduled successfully.' });

    } catch (error) {
        console.error('Error scheduling session:', error);
        res.status(500).json({ message: 'Server error: Failed to schedule session.' });
    }
});

// Export the router
export default router;
