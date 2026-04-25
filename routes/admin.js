// routes/admin.js

import express from 'express';
import admin from 'firebase-admin';
import verifyToken from '../middleware/auth.js';
import checkRole from '../middleware/checkRole.js';
import multer from 'multer';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { v2 as cloudinary } from 'cloudinary';
import { sendGeneralEmail } from '../services/sendGridService.js';
import { notifyUser } from '../services/notificationService.js';

// Create a new Express Router instance
const router = express.Router();
const db = admin.firestore();
const SUBSCRIPTION_DURATIONS_MONTHS = {
    free: 3,
    pro: 3,
};

// Cloudinary configuration (this is fine to keep here as it's specific to file uploads)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Cloudinary storage setup for corrected documents (for general review)
const correctedStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
        const documentId = req.params.documentId || `doc-${Date.now()}`;
        return {
            folder: `grad-tracker/corrected-documents`,
            public_id: `corrected-${documentId}-${Date.now()}`,
            resource_type: 'raw',
            format: file.mimetype.split('/')[1],
        };
    },
});
const uploadCorrected = multer({ storage: correctedStorage });

// Cloudinary storage setup for corrected CVs (for CV service)
const correctedCVStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: (req, file) => {
        const requestId = req.params.requestId || `cv-req-${Date.now()}`;
        return {
            folder: `grad-tracker/corrected-cvs`,
            public_id: `corrected-cv-${requestId}-${Date.now()}`,
            resource_type: 'raw',
            format: file.mimetype.split('/')[1],
        };
    },
});
const uploadCorrectedCV = multer({ storage: correctedCVStorage });

// Cloudinary storage setup for initial CV uploads from users
const initialCVStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: (req, file) => {
        // NOTE: req.user is populated by verifyToken middleware
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


// ** ACADEMIC CV SERVICE ROUTES (USER-FACING) **

// 1. Route for a user to submit their CV for review (Added 'notes' handling)
router.post('/cv-service/submit', verifyToken, uploadInitialCV.single('cvFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded. Please submit a CV.' });
        }
        
        const userId = req.user.uid;
        const userEmail = req.user.email;
        const { notes } = req.body; // Extract optional notes

        // Check if a pending or scheduled request already exists for this user
        const existingRequest = await db.collection('cv_requests')
            .where('userId', '==', userId)
            .where('status', 'in', ['pending', 'scheduled'])
            .limit(1)
            .get();

        if (!existingRequest.empty) {
            return res.status(409).json({ message: 'You already have a pending or scheduled CV review request.' });
        }

        const cvRequestsRef = db.collection('cv_requests');
        const newRequestDoc = await cvRequestsRef.add({
            userId,
            userEmail,
            cvUrl: req.file.path,
            notes: notes || '',
            status: 'pending',
            type: 'cv_upload',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(201).json({
            message: 'Academic CV service request submitted successfully.',
            requestId: newRequestDoc.id,
            cvUrl: req.file.path
        });
    } catch (error) {
        console.error('Error submitting CV service request:', error);
        res.status(500).json({ message: 'Server error: Failed to submit request.' });
    }
});

// 2. Route for a user to get their CV request status (UPDATED fields to match frontend expectation)
router.get('/cv-service/my-request', verifyToken, async (req, res) => {
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

        res.status(200).json({
            id: doc.id,
            status: data.status,
            // Map DB field 'createdAt' to client field 'timestamp'
            timestamp: data.createdAt?.toDate().toISOString(), 
            // Map DB field 'cvUrl' to client field 'uploadedFileUrl'
            uploadedFileUrl: data.cvUrl || null,
            // Map DB field 'correctedCvUrl' to client field 'finalDocumentUrl'
            finalDocumentUrl: data.correctedCvUrl || null, 
            mentorFeedback: data.mentorFeedback || null,
            scheduledDate: data.scheduledDate || null,
            scheduledTime: data.scheduledTime || null,
            zoomLink: data.zoomLink || null,
            notes: data.notes || null,
            type: data.type || 'cv_upload', // Ensure type is returned
        });

    } catch (error) {
        console.error('Error fetching user\'s CV request:', error);
        res.status(500).json({ message: 'Failed to retrieve your request status.' });
    }
});

// ** ACADEMIC CV SERVICE ROUTES (ADMIN-FACING) **

// 3. Route for admin to get ALL CV requests (pending and completed) (No change needed)
router.get('/cv-service/all-reviews', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const cvRequestsSnapshot = await db.collection('cv_requests')
            .orderBy('createdAt', 'desc')
            .get();

        const cvRequests = cvRequestsSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                ...data,
                createdAt: data.createdAt?.toDate().toISOString()
            };
        });
        res.status(200).json(cvRequests);
    } catch (error) {
        console.error('Error fetching all CV requests:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// 4. UPDATED: Combined Route for admin to update status, upload corrected CV, and add scheduling info
router.put('/cv-service/review/:requestId', verifyToken, checkRole('admin'), uploadCorrectedCV.single('correctedCV'), async (req, res) => {
    try {
        const { requestId } = req.params;
        // Destructure all possible update fields
        const { status, mentorFeedback, scheduledDate, scheduledTime, zoomLink } = req.body; 

        if (!status) {
            return res.status(400).json({ message: 'Status is required for review update.' });
        }

        const requestRef = db.collection('cv_requests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists) {
            return res.status(404).json({ message: 'CV request not found.' });
        }

        const updateData = {
            status,
            mentorFeedback: mentorFeedback || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // Handle file upload
        if (req.file) {
            updateData.correctedCvUrl = req.file.path;
        }

        // Logic for 'scheduled' status
        if (status === 'scheduled') {
            if (!scheduledDate || !scheduledTime || !zoomLink) {
                return res.status(400).json({ message: 'Date, time, and Zoom link are required for status "scheduled".' });
            }
            updateData.scheduledDate = scheduledDate;
            updateData.scheduledTime = scheduledTime;
            updateData.zoomLink = zoomLink;

            // Notification for scheduling
            await notifyUser(requestDoc.data().userId, {
                senderId: req.user.uid,
                pushTitle: 'CV Session Scheduled',
                pushBody: `Your CV review session has been scheduled for ${scheduledDate} at ${scheduledTime}.`,
                emailSubject: 'CV Session Scheduled',
                emailHtml: `<p>Your CV review session has been scheduled for ${scheduledDate} at ${scheduledTime}.</p>`,
                pushUrl: '/services/cv-review',
                type: 'cv_session_scheduled',
                relatedEntityId: requestId,
                metadata: { requestId, scheduledDate, scheduledTime, zoomLink },
            });
        } 
        
        // Logic for 'completed' / 'feedback' status (requires final document)
        else if (status === 'review_complete' || status === 'completed' || status === 'feedback') {
            // Check if correctedCvUrl is in the update OR already exists in the document
            if (!updateData.correctedCvUrl && !requestDoc.data().correctedCvUrl) {
                return res.status(400).json({ 
                    message: `A corrected CV file must be uploaded or already linked to set status to '${status}'.` 
                });
            }
            // Notification for review complete
            await notifyUser(requestDoc.data().userId, {
                senderId: req.user.uid,
                pushTitle: 'CV Review Complete',
                pushBody: 'Your academic CV review is complete. You can now download the corrected version.',
                emailSubject: 'CV Review Complete',
                emailHtml: `<p>Your academic CV review is complete. You can now download the corrected version.</p>`,
                pushUrl: '/services/cv-review',
                type: 'cv_review_complete',
                relatedEntityId: requestId,
                metadata: { requestId, status },
            });
        }

        // If status changes away from scheduled, clear scheduling fields to avoid confusion
        if (status !== 'scheduled') {
            // Using FieldValue.delete() to remove fields if they exist
            updateData.scheduledDate = admin.firestore.FieldValue.delete();
            updateData.scheduledTime = admin.firestore.FieldValue.delete();
            updateData.zoomLink = admin.firestore.FieldValue.delete();
        }

        await requestRef.update(updateData);

        res.status(200).json({ 
            message: `CV request updated to '${status}' successfully.`, 
            updateData 
        });
    } catch (err) {
        console.error('Error updating CV review:', err);
        res.status(500).json({ message: 'Server error.', error: err.message });
    }
});


// ** EXISTING GENERAL ADMIN ROUTES (MIGRATED TO FIRESTORE) **

// GET all documents awaiting review (No change needed)
router.get('/documents/for-review', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const documentsSnapshot = await db.collection('documents').where('status', '==', 'pending_review').get();
        const documents = documentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(documents);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Route to handle admin uploading a corrected document (No change needed)
router.post('/documents/correct/:documentId', verifyToken, checkRole('admin'), uploadCorrected.single('correctedDocument'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded.' });
        }

        const { documentId } = req.params;
        const correctedFileUrl = req.file.path;

        const documentRef = db.collection('documents').doc(documentId);
        const documentDoc = await documentRef.get();

        if (!documentDoc.exists) {
            return res.status(404).json({ message: 'Document not found.' });
        }

        await documentRef.update({
            correctedFileUrl: correctedFileUrl,
            status: 'review_complete',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        res.status(200).json({ message: 'Document review complete and corrected file uploaded.', document: { id: documentId, ...documentDoc.data(), correctedFileUrl, status: 'review_complete' } });
    } catch (err) {
        console.error('Error uploading corrected document:', err);
        res.status(500).json({ message: 'Server error.', error: err.message });
    }
});

// NEW route to get all mentorship connections for admin (No change needed)
router.get('/mentorship/connections', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const connectionsSnapshot = await db.collection('mentorRequests')
            .where('status', 'in', ['accepted', 'pending'])
            .get();

        const connections = await Promise.all(connectionsSnapshot.docs.map(async (doc) => {
            const data = doc.data();
            const menteeDoc = await db.collection('users').doc(data.menteeId).get();
            const mentorDoc = await db.collection('users').doc(data.mentorId).get();

            return {
                id: doc.id,
                menteeName: `${menteeDoc.data()?.firstName || ''} ${menteeDoc.data()?.lastName || ''}`.trim(),
                mentorName: `${mentorDoc.data()?.firstName || ''} ${mentorDoc.data()?.lastName || ''}`.trim(),
                status: data.status,
                createdAt: data.createdAt?.toDate().toISOString(), // Use optional chaining for safe access
            };
        }));
        res.status(200).json(connections);
    } catch (error) {
        console.error('Error fetching all mentorship connections:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// NEW: Route to allow an admin to revoke a mentorship connection (FIXED notification field)
router.delete('/mentorship/connections/:requestId', verifyToken, checkRole('admin'), async (req, res) => {
    const { requestId } = req.params;
    try {
        const requestRef = db.collection('mentorRequests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists) {
            return res.status(404).json({ message: 'Mentorship request not found.' });
        }

        const data = requestDoc.data();
        const menteeId = data.menteeId;
        const mentorId = data.mentorId;
        
        const menteeRef = db.collection('users').doc(menteeId);
        const mentorRef = db.collection('users').doc(mentorId);

        // Fetch user documents to get names for notifications.
        const menteeDoc = await menteeRef.get();
        const mentorDoc = await mentorRef.get();

        const batch = db.batch();
        
        // 1. Update the mentor request status to 'revoked'
        batch.update(requestRef, { status: 'revoked' });

        // 2. Remove the connection from the mentee's profile
        batch.update(menteeRef, {
            mentorId: admin.firestore.FieldValue.delete(),
            isConnectedToMentor: false,
        });

        // 3. Remove the mentee from the mentor's connected users array
        batch.update(mentorRef, {
            connectedUsers: admin.firestore.FieldValue.arrayRemove(menteeId),
        });

        // 4. Create a notification for both the mentor and the mentee
        const notificationMenteeRef = db.collection('notifications').doc();
        batch.set(notificationMenteeRef, {
            userId: menteeId, // FIX: Use 'userId'
            senderId: req.user.uid, // Admin ID
            type: 'mentorship_revoked',
            message: `Your mentorship with ${mentorDoc.data()?.firstName || 'a mentor'} was revoked by an admin.`,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        
        const notificationMentorRef = db.collection('notifications').doc();
        batch.set(notificationMentorRef, {
            userId: mentorId, // FIX: Use 'userId'
            senderId: req.user.uid, // Admin ID
            type: 'mentorship_revoked',
            message: `Your mentorship with ${menteeDoc.data()?.firstName || 'a user'} was revoked by an admin.`,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();

        res.status(200).json({ message: 'Mentorship connection successfully revoked by admin.' });
    } catch (error) {
        console.error('Error revoking mentorship:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ADMIN: Broadcast email to all users
// POST /admin/broadcast-email
// body: { subject: string, html: string }
router.post('/broadcast-email', checkRole('admin'), async (req, res) => {
    try {
        console.log('📧 Broadcast email route hit');
        const { subject, html } = req.body;

        if (!subject || !html) {
            return res.status(400).json({ message: 'Subject and html body are required.' });
        }

        // Fetch user emails (only active users with an email)
        const usersSnapshot = await db.collection('users').where('email', '!=', null).get();
        if (usersSnapshot.empty) {
            return res.status(200).json({ message: 'No users found to send emails to.' });
        }

        const emails = [];
        usersSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.email) emails.push(data.email);
        });

        // Simple safety limit to avoid blasting too many emails at once
        const BATCH_LIMIT = parseInt(process.env.ADMIN_BROADCAST_BATCH_LIMIT || '500', 10);
        if (emails.length > BATCH_LIMIT) {
            // Instead of sending immediately, respond with count and require explicit confirmation in UI
            return res.status(400).json({ message: `Too many recipients (${emails.length}). Reduce recipients or increase ADMIN_BROADCAST_BATCH_LIMIT.` });
        }

        // Send emails sequentially (could be parallelized, but keep simple and rate-friendly)
        const results = [];
        for (const toEmail of emails) {
            try {
                await sendGeneralEmail(toEmail, subject, html);
                results.push({ to: toEmail, status: 'sent' });
            } catch (err) {
                results.push({ to: toEmail, status: 'failed', error: err.message });
            }
        }

        return res.status(200).json({ message: 'Broadcast completed.', total: emails.length, results });
    } catch (err) {
        console.error('Error broadcasting email:', err);
        return res.status(500).json({ message: 'Server error during broadcast.', error: err.message });
    }
});

// Route to handle admin sending a response to an interview prep request (No change needed)
router.post('/interview-prep/send-response', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const { requestId, message, scheduledDate, scheduledTime, zoomLink } = req.body;

        if (!requestId || !message || !scheduledDate || !scheduledTime || !zoomLink) {
            return res.status(400).json({ message: 'Request ID, message, date, time, and Zoom link are required.' });
        }

        const requestRef = db.collection('interview_prep_requests').doc(requestId);
        await requestRef.update({
            adminResponse: message,
            scheduledDate,
            scheduledTime,
            zoomLink,
            status: 'scheduled',
            respondedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Get the request data to craft a specific notification message
        const requestDoc = await requestRef.get();
        if (requestDoc.exists) {
            const requestData = requestDoc.data();
            const userId = requestData?.userId;
            if (userId) {
                await notifyUser(userId, {
                    senderId: req.user.uid,
                    pushTitle: 'Interview Prep Scheduled',
                    pushBody: `Your interview prep session for ${requestData?.schoolName} has been scheduled for ${scheduledDate} at ${scheduledTime}. The Zoom link is: ${zoomLink}.`,
                    emailSubject: 'Interview Prep Scheduled',
                    emailHtml: `<p>Your interview prep session for ${requestData?.schoolName} has been scheduled for ${scheduledDate} at ${scheduledTime}. The Zoom link is: ${zoomLink}.</p>`,
                    pushUrl: '/interview-prep',
                    type: 'interview_prep_response',
                    relatedEntityId: requestId,
                    metadata: { requestId, scheduledDate, scheduledTime, zoomLink },
                });
            }
        }

        res.status(200).json({ message: 'Response sent successfully.' });
    } catch (error) {
        console.error('Error sending admin response:', error);
        res.status(500).json({ message: 'Failed to send response.' });
    }
});

// NEW: Route to handle admin sending a response to a visa interview prep request (No change needed)
router.post('/visa-prep/send-response', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const { requestId, message, scheduledDate, scheduledTime, zoomLink } = req.body;

        if (!requestId || !message || !scheduledDate || !scheduledTime || !zoomLink) {
            return res.status(400).json({ message: 'Request ID, message, date, time, and Zoom link are required.' });
        }

        const requestRef = db.collection('visa_interview_prep_requests').doc(requestId);
        await requestRef.update({
            adminResponse: message,
            scheduledDate,
            scheduledTime,
            zoomLink,
            status: 'scheduled',
            respondedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const requestDoc = await requestRef.get();
        if (requestDoc.exists) {
            const requestData = requestDoc.data();
            const userId = requestData?.userId;
            if (userId) {
                await notifyUser(userId, {
                    senderId: req.user.uid,
                    pushTitle: 'Visa Prep Scheduled',
                    pushBody: `Your visa prep session for ${requestData?.visaType} has been scheduled for ${scheduledDate} at ${scheduledTime}. The Zoom link is: ${zoomLink}.`,
                    emailSubject: 'Visa Prep Scheduled',
                    emailHtml: `<p>Your visa prep session for ${requestData?.visaType} has been scheduled for ${scheduledDate} at ${scheduledTime}. The Zoom link is: ${zoomLink}.</p>`,
                    pushUrl: '/services/visa-prep',
                    type: 'visa_prep_response',
                    relatedEntityId: requestId,
                    metadata: { requestId, scheduledDate, scheduledTime, zoomLink },
                });
            }
        }

        res.status(200).json({ message: 'Visa prep response sent successfully.' });
    } catch (error) {
        console.error('Error sending admin visa prep response:', error);
        res.status(500).json({ message: 'Failed to send response.' });
    }
});

// NEW: Route to handle admin sending a response to a financial support request (No change needed)
router.post('/financial-support/send-response', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const { requestId, message, scheduledDate, scheduledTime, zoomLink, status } = req.body;

        if (!requestId || !status) {
            return res.status(400).json({ message: 'Request ID and status are required.' });
        }

        const requestRef = db.collection('financial_support_requests').doc(requestId);
        const updateData = {
            adminResponse: message,
            status: status,
            respondedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        if (status === 'scheduled') {
            if (!scheduledDate || !scheduledTime || !zoomLink) {
                return res.status(400).json({ message: 'Date, time, and Zoom link are required for scheduled requests.' });
            }
            updateData.scheduledDate = scheduledDate;
            updateData.scheduledTime = scheduledTime;
            updateData.zoomLink = zoomLink;
        }

        await requestRef.update(updateData);

        const requestDoc = await requestRef.get();
        if (requestDoc.exists) {
            const requestData = requestDoc.data();
            const userId = requestData?.userId;
            
            if (userId) {
                let notificationMessage = '';
                if (status === 'scheduled') {
                    notificationMessage = `Your financial support session for ${requestData?.universityName} has been scheduled for ${scheduledDate} at ${scheduledTime}.`;
                } else if (status === 'declined') {
                    notificationMessage = `Your financial support request for ${requestData?.universityName} has been declined.`;
                } else {
                    notificationMessage = `Your financial support request for ${requestData?.universityName} has been updated.`;
                }

                await notifyUser(userId, {
                    senderId: req.user.uid,
                    pushTitle: 'Financial Support Update',
                    pushBody: notificationMessage,
                    emailSubject: 'Financial Support Update',
                    emailHtml: `<p>${notificationMessage}</p>`,
                    pushUrl: '/services/financial-support',
                    type: 'financial_support_response',
                    relatedEntityId: requestId,
                    metadata: { requestId, status, scheduledDate, scheduledTime, zoomLink },
                });
            }
        }

        res.status(200).json({ message: 'Financial support response sent successfully.' });
    } catch (error) {
        console.error('Error sending financial support response:', error);
        res.status(500).json({ message: 'Failed to send response.', error: error.message });
    }
});

// --- USER MANAGEMENT ROUTES (ADMIN) ---

// GET all registered users (for AdminUserManagement component)
router.get('/users', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        // 1. Fetch all user profile documents from Firestore
        const usersSnapshot = await db.collection('users').get();
        
        // 2. Map through the documents and fetch the corresponding Firebase Auth record
        const users = await Promise.all(usersSnapshot.docs.map(async doc => {
            const data = doc.data();
            const uid = doc.id;
            
            // Fetch the user record from Firebase Authentication
            let authUser;
            let emailVerified = false;
            try {
                authUser = await admin.auth().getUser(uid);
                emailVerified = authUser.emailVerified;
            } catch (authError) {
                // Handle case where user might exist in Firestore but not in Auth (unlikely, but safe)
                console.warn(`Auth record not found for user: ${uid}`);
            }

            return {
                id: uid,
                firstName: data.firstName || '',
                lastName: data.lastName || '',
                email: data.email || '',
                role: data.role || 'user', 
                gender: data.gender || 'N/A', 
                subscription: data.subscription || {},
                // ✨ CRITICAL ADDITION: Get the actual status from Firebase Auth
                isEmailVerified: emailVerified, 
                // ---------------------
                createdAt: data.createdAt?.toDate().toISOString() || new Date().toISOString(),
                photoURL: data.photoURL || null,
                bio: data.bio || '',
                connections: data.connections || [],
                receiveNotifications: data.receiveNotifications !== undefined ? data.receiveNotifications : true,
            };
        }));

        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching all users:', error);
        res.status(500).json({ message: 'Failed to retrieve user list.' });
    }
});

// DELETE a user by ID (No change needed)
router.delete('/users/:userId', verifyToken, checkRole('admin'), async (req, res) => {
    const { userId } = req.params;
    try {
        // 1. Delete the user from Firebase Authentication
        await admin.auth().deleteUser(userId);

        // 2. Delete the user's profile document from Firestore
        await db.collection('users').doc(userId).delete();

        res.status(200).json({ message: `User ${userId} and their data successfully deleted.` });
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            return res.status(404).json({ message: 'User not found.' });
        }
        console.error('Error deleting user:', error);
        res.status(500).json({ message: 'Failed to delete user.', error: error.message });
    }
});

// UPDATED: PUT route to update a user's profile and role (FIXED: Handles gender and returns all expected fields)
router.put('/users/:userId', verifyToken, checkRole('admin'), async (req, res) => {
    const { userId } = req.params;
    // ADDED: include 'gender'
    const { firstName, lastName, role, gender } = req.body; 

    // Build the data object for Firestore (profile update)
    const firestoreUpdateData = {};
    if (firstName !== undefined) firestoreUpdateData.firstName = firstName;
    if (lastName !== undefined) firestoreUpdateData.lastName = lastName;
    // ADDED: update gender in Firestore
    if (gender !== undefined) firestoreUpdateData.gender = gender;
    
    // Validate and set the role if provided
    let newRole = null;
    if (role) {
        if (role === 'admin' || role === 'user' || role === 'mentor') {
            firestoreUpdateData.role = role;
            newRole = role;
        } else {
            return res.status(400).json({ message: 'Invalid role provided. Must be admin, user, or mentor.' });
        }
    }

    // Must have something to update
    if (Object.keys(firestoreUpdateData).length === 0) {
        return res.status(400).json({ message: 'No valid fields provided for update.' });
    }

    try {
        // 1. Update Custom Claims in Firebase Auth (only if the role changed)
        if (newRole) {
            const user = await admin.auth().getUser(userId);
            // This is the CRITICAL step to update the role for security checks
            await admin.auth().setCustomUserClaims(user.uid, { role: newRole });
        }

        // 2. Update profile fields (and role) in the Firestore 'users' collection
        await db.collection('users').doc(userId).update(firestoreUpdateData);

        // 3. Fetch the fully updated user data to return to the client
        const updatedDoc = await db.collection('users').doc(userId).get();
        const updatedData = updatedDoc.data();
        
        // Return the full updated object matching the client interface
        const updatedUser = {
            id: updatedDoc.id,
            firstName: updatedData?.firstName || '',
            lastName: updatedData?.lastName || '',
            email: updatedData?.email || '',
            role: updatedData?.role || 'user',
            gender: updatedData?.gender || 'N/A', // **FIXED: Return gender field**
            createdAt: updatedData?.createdAt?.toDate().toISOString() || new Date().toISOString(),
            photoURL: updatedData?.photoURL || null,
            bio: updatedData?.bio || '',
            connections: updatedData?.connectedUsers || [], // Use connectedUsers from DB
            receiveNotifications: updatedData?.receiveNotifications !== undefined ? updatedData.receiveNotifications : true,
        };

        res.status(200).json(updatedUser);
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
            return res.status(404).json({ message: 'User not found.' });
        }
        console.error('Error updating user:', error);
        res.status(500).json({ message: 'Failed to update user.', error: error.message });
    }
});

// ADMIN: Update a user's subscription plan
router.put('/users/:userId/subscription', verifyToken, checkRole('admin'), async (req, res) => {
    const { userId } = req.params;
    const { plan, status } = req.body;
    const normalizedPlan = String(plan || '').toLowerCase() === 'premium' ? 'pro' : String(plan || '').toLowerCase();

    if (!normalizedPlan || !['free', 'pro'].includes(normalizedPlan)) {
        return res.status(400).json({ message: 'Invalid subscription plan. Must be free or pro.' });
    }

    if (status && !['active', 'cancelled', 'expired'].includes(String(status).toLowerCase())) {
        return res.status(400).json({ message: 'Invalid subscription status. Must be active, cancelled, or expired.' });
    }

    try {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const durationMonths = SUBSCRIPTION_DURATIONS_MONTHS[normalizedPlan] || 3;
        const expirationDate = new Date();
        expirationDate.setMonth(expirationDate.getMonth() + durationMonths);

        const currentSubscription = userDoc.data()?.subscription || {};
        const updatedSubscription = {
            ...currentSubscription,
            plan: normalizedPlan,
            status: String(status || 'active').toLowerCase(),
            startDate: new Date().toISOString(),
            expirationDate: expirationDate.toISOString(),
        };

        await userRef.update({
            subscription: updatedSubscription,
        });

        return res.status(200).json({
            message: 'Subscription updated successfully.',
            subscription: updatedSubscription,
        });
    } catch (error) {
        console.error('Error updating subscription:', error);
        return res.status(500).json({ message: 'Failed to update subscription.', error: error.message });
    }
});

// GET all users with active subscriptions
router.get('/subscriptions', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users')
            .where('subscription.status', '==', 'active')
            .get();

        const subscribers = usersSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                firstName: data.firstName || '',
                lastName: data.lastName || '',
                email: data.email || '',
                subscription: data.subscription || {},
                createdAt: data.createdAt?.toDate?.()?.toISOString?.() || '',
            };
        });

        res.status(200).json({
            total: subscribers.length,
            subscribers: subscribers.sort((a, b) => {
                const dateA = new Date(b.subscription.startDate || 0);
                const dateB = new Date(a.subscription.startDate || 0);
                return dateA - dateB;
            }),
        });
    } catch (error) {
        console.error('Error fetching subscriptions:', error);
        res.status(500).json({ message: 'Failed to retrieve subscriptions.', error: error.message });
    }
});

// GET all users with payment history (users who made payments)
router.get('/payments', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users')
            .where('subscription.paymentReference', '!=', null)
            .get();

        const paymentHistory = usersSnapshot.docs.map(doc => {
            const data = doc.data();
            const sub = data.subscription || {};
            return {
                id: doc.id,
                firstName: data.firstName || '',
                lastName: data.lastName || '',
                email: data.email || '',
                plan: sub.plan || '',
                status: sub.status || 'unknown',
                paymentCurrency: sub.paymentCurrency || '',
                paymentGateway: sub.paymentGateway || '',
                paymentReference: sub.paymentReference || '',
                startDate: sub.startDate || '',
                expirationDate: sub.expirationDate || '',
                createdAt: data.createdAt?.toDate?.()?.toISOString?.() || '',
            };
        });

        res.status(200).json({
            total: paymentHistory.length,
            payments: paymentHistory.sort((a, b) => {
                const dateA = new Date(b.startDate || 0);
                const dateB = new Date(a.startDate || 0);
                return dateA - dateB;
            }),
        });
    } catch (error) {
        console.error('Error fetching payments:', error);
        res.status(500).json({ message: 'Failed to retrieve payment history.', error: error.message });
    }
});

export default router;
