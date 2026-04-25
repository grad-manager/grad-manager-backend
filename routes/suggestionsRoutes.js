// ./routes/suggestionsRoutes.js

import express from 'express';
// ⚠️ IMPORTANT: You must import these functions/objects for the router file to work.
import verifyToken from '../middleware/auth.js'; 
import checkRole from '../middleware/checkRole.js'; 
import { admin } from '../config/firebase-config.js'; // Assuming this provides admin access
import { notifyUser } from '../services/notificationService.js';
// Assuming you have a Firestore instance or initialize one here
const db = admin.firestore();

const router = express.Router();

// ** PROGRAM SUGGESTION ROUTES **
// -------------------------------------

// 1. Route for a USER to submit a new program suggestion
// The path '/' is now POST /api/program-suggestions
router.post('/', verifyToken, async (req, res) => {
    // Does NOT require checkRole('admin') as users submit the suggestion
    const userId = req.user.uid; 
    const { 
        university, 
        department, 
        deadline, 
        funding, 
        fundingAmount, 
        greWaiver, 
        ieltsWaiver, 
        appFeeWaiver, 
        requiredDocs, 
        professors, 
        appLink 
    } = req.body;

    // --- Basic Server-Side Validation ---
    if (!university || !department || !funding) {
        return res.status(400).json({ 
            message: 'Missing required fields: university, department, and funding status are mandatory.',
        });
    }

    // Sanitize and structure the data
    const suggestionData = {
        university: university.trim(),
        department: department.trim(),
        funding: funding.trim(),

        deadline: deadline || null,
        fundingAmount: fundingAmount || null,
        greWaiver: greWaiver !== undefined ? greWaiver : null,
        ieltsWaiver: ieltsWaiver !== undefined ? ieltsWaiver : null,
        appFeeWaiver: appFeeWaiver !== undefined ? appFeeWaiver : null,
        requiredDocs: Array.isArray(requiredDocs) ? requiredDocs : (requiredDocs ? [requiredDocs] : []), 
        professors: professors || null,
        appLink: appLink || null,

        // Metadata
        submittedBy: userId,
        status: 'pending_review', // Initial status for admin
        submissionDate: admin.firestore.FieldValue.serverTimestamp(),
    };

    try {
        // Store the Suggestion in the new 'programSuggestions' collection
        const newDocRef = await db.collection('programSuggestions').add(suggestionData);

        const adminsSnapshot = await db.collection('users').where('role', '==', 'admin').get();
        const adminNotifications = adminsSnapshot.docs.map((doc) =>
            notifyUser(doc.id, {
                senderId: userId,
                pushTitle: 'New Program Suggestion',
                pushBody: `New suggestion for ${suggestionData.university} (${suggestionData.department}).`,
                emailSubject: 'New Program Suggestion',
                emailHtml: `<p>New suggestion for ${suggestionData.university} (${suggestionData.department}).</p>`,
                pushUrl: '/admin',
                type: 'GENERAL',
                relatedEntityId: newDocRef.id,
                metadata: { requestType: 'program_suggestion', suggestionId: newDocRef.id },
            })
        );
        await Promise.allSettled(adminNotifications);

        res.status(201).json({ 
            message: 'Program suggestion submitted successfully for admin review.',
            id: newDocRef.id
        });

    } catch (error) {
        console.error('Error submitting program suggestion:', error);
        res.status(500).json({ 
            message: 'An unexpected error occurred while processing your suggestion.',
        });
    }
});


// 2. Route for ADMIN to retrieve all program suggestions
// The path '/' is now GET /api/program-suggestions
router.get('/', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const suggestionsSnapshot = await db.collection('programSuggestions')
            .orderBy('submissionDate', 'desc')
            .get();

        const suggestions = suggestionsSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                ...data,
                // Ensure the date is correctly converted for the frontend
                submissionDate: data.submissionDate?.toDate ? data.submissionDate.toDate().toISOString() : data.submissionDate
            };
        });

        res.status(200).json(suggestions);
    } catch (error) {
        console.error('Error fetching program suggestions:', error);
        res.status(500).json({ message: 'Failed to retrieve program suggestions.' });
    }
});

// 3. Route for ADMIN to update the status of a suggestion (e.g., PUT /api/program-suggestions/:id/status)
router.put('/:id/status', verifyToken, checkRole('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body; // Expects 'approved' or 'rejected'
        
        if (status !== 'approved' && status !== 'rejected') {
            return res.status(400).json({ message: 'Invalid status provided. Must be "approved" or "rejected".' });
        }

        const suggestionRef = db.collection('programSuggestions').doc(id);
        const suggestionDoc = await suggestionRef.get();
        if (!suggestionDoc.exists) {
            return res.status(404).json({ message: 'Program suggestion not found.' });
        }

        const suggestionData = suggestionDoc.data();

        await suggestionRef.update({ 
            status: status,
            // Add a timestamp for when the review was completed
            reviewDate: admin.firestore.FieldValue.serverTimestamp()
        });

        if (suggestionData?.submittedBy) {
            const responseMessage =
                status === 'approved'
                    ? 'Your program suggestion has been approved by our admin team.'
                    : 'Your program suggestion has been reviewed and rejected by our admin team.';

            await notifyUser(suggestionData.submittedBy, {
                senderId: req.user.uid,
                pushTitle: 'Program Suggestion Update',
                pushBody: responseMessage,
                emailSubject: 'Program Suggestion Update',
                emailHtml: `<p>${responseMessage}</p>`,
                pushUrl: '/programs',
                type: 'GENERAL',
                relatedEntityId: id,
                metadata: { suggestionId: id, status },
            });
        }

        res.status(200).json({ 
            message: `Program suggestion ${id} status updated to ${status}.` 
        });

    } catch (error) {
        console.error('Error updating suggestion status:', error);
        // Check if the error is a document not found error
        if (error.code === 'not-found') {
            return res.status(404).json({ message: 'Program suggestion not found.' });
        }
        res.status(500).json({ message: 'Failed to update suggestion status.' });
    }
});


export default router;
