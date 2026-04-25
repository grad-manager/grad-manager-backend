import express from 'express';
import { admin } from '../config/firebase-config.js'; 
import verifyToken from '../middleware/auth.js'; 
import checkRole from '../middleware/checkRole.js'; // Import the new middleware

const router = express.Router();
const db = admin.firestore();

// 1. Route to fetch all available mentors
router.get('/', verifyToken, async (req, res) => {
    try {
        const mentorsSnapshot = await db.collection('users')
            .where('role', '==', 'mentor')
            .where('isAvailable', '==', true)
            .get();
        
        const mentors = mentorsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
        }));
        
        res.status(200).json(mentors);
    } catch (error) {
        console.error('Error fetching mentors:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// 2. Route to handle a mentor connection request
router.post('/request', verifyToken, async (req, res) => {
    const { mentorId } = req.body;
    const menteeId = req.user.uid;

    if (!mentorId || !menteeId) {
        return res.status(400).json({ message: 'Mentor and mentee IDs are required.' });
    }

    try {
        const requestRef = db.collection('mentorRequests').doc();
        await requestRef.set({
            menteeId,
            mentorId,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const menteeDoc = await db.collection('users').doc(menteeId).get();
        const menteeName = menteeDoc.data()?.firstName || 'A user';

        const notificationRef = db.collection('notifications').doc();
        await notificationRef.set({
            recipientId: mentorId,
            senderId: menteeId,
            type: 'mentor_request',
            message: `${menteeName} has sent you a mentorship request.`,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            relatedRequestId: requestRef.id,
        });

        res.status(200).json({ message: 'Mentorship request sent successfully.' });
    } catch (error) {
        console.error('Error sending mentor request:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// 3. Route for mentor to accept a request
router.post('/accept', verifyToken, async (req, res) => {
    const { requestId } = req.body;
    const mentorId = req.user.uid;

    if (!requestId) {
        return res.status(400).json({ message: 'Request ID is required.' });
    }

    try {
        const requestRef = db.collection('mentorRequests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists || requestDoc.data()?.mentorId !== mentorId) {
            return res.status(403).json({ message: 'Unauthorized or request not found.' });
        }

        const menteeId = requestDoc.data().menteeId;
        const menteeRef = db.collection('users').doc(menteeId);
        const mentorRef = db.collection('users').doc(mentorId);

        const batch = db.batch();
        
        batch.update(requestRef, { status: 'accepted' });
        batch.update(menteeRef, { mentorId: mentorId, isConnectedToMentor: true });
        batch.update(mentorRef, { connectedUsers: admin.firestore.FieldValue.arrayUnion(menteeId) });

        const mentorDoc = await mentorRef.get();
        const mentorName = mentorDoc.data()?.firstName || 'A mentor';

        const notificationRef = db.collection('notifications').doc();
        batch.set(notificationRef, {
            recipientId: menteeId,
            senderId: mentorId,
            type: 'mentor_request_response',
            message: `${mentorName} has accepted your mentorship request!`,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();
        res.status(200).json({ message: 'Request accepted and user connected.' });
    } catch (error) {
        console.error('Error accepting request:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// 4. Route for mentor to decline a request
router.post('/decline', verifyToken, async (req, res) => {
    const { requestId, reason } = req.body;
    const mentorId = req.user.uid;

    if (!requestId) {
        return res.status(400).json({ message: 'Request ID is required.' });
    }

    try {
        const requestRef = db.collection('mentorRequests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists || requestDoc.data()?.mentorId !== mentorId) {
            return res.status(403).json({ message: 'Unauthorized or request not found.' });
        }

        const menteeId = requestDoc.data().menteeId;
        const mentorRef = db.collection('users').doc(mentorId);

        const batch = db.batch();
        
        batch.update(requestRef, { status: 'declined', reason: reason || 'No reason provided.' });

        const mentorDoc = await mentorRef.get();
        const mentorName = mentorDoc.data()?.firstName || 'A mentor';

        const notificationRef = db.collection('notifications').doc();
        batch.set(notificationRef, {
            recipientId: menteeId,
            senderId: mentorId,
            type: 'mentor_request_response',
            message: `${mentorName} has declined your mentorship request.`,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        
        await batch.commit();
        res.status(200).json({ message: 'Request declined.' });
    } catch (error) {
        console.error('Error declining request:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Existing Route: Fetch pending mentor requests for the logged-in mentor
router.get('/requests', verifyToken, checkRole('mentor'), async (req, res) => {
    const mentorId = req.user.uid;

    try {
        const requestsSnapshot = await db.collection('mentorRequests')
            .where('mentorId', '==', mentorId)
            .where('status', '==', 'pending')
            .get();

        const requests = await Promise.all(requestsSnapshot.docs.map(async (doc) => {
            const requestData = doc.data();
            const menteeDoc = await db.collection('users').doc(requestData.menteeId).get();
            const menteeName = menteeDoc.data()?.firstName || 'A user';

            return {
                id: doc.id,
                ...requestData,
                menteeName,
                createdAt: requestData.createdAt.toDate().toISOString(),
            };
        }));

        res.status(200).json(requests);
    } catch (error) {
        console.error('Error fetching mentor requests:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// NEW: Route to get all accepted mentorship connections for a specific mentor
router.get('/connections', verifyToken, checkRole('mentor'), async (req, res) => {
    const mentorId = req.user.uid;

    try {
        const connectionsSnapshot = await db.collection('mentorRequests')
            .where('mentorId', '==', mentorId)
            .where('status', '==', 'accepted')
            .get();

        const connections = await Promise.all(connectionsSnapshot.docs.map(async (doc) => {
            const data = doc.data();
            const menteeDoc = await db.collection('users').doc(data.menteeId).get();

            return {
                id: doc.id,
                menteeName: menteeDoc.data()?.firstName + ' ' + menteeDoc.data()?.lastName,
                status: data.status,
                createdAt: data.createdAt.toDate().toISOString(),
            };
        }));
        res.status(200).json(connections);
    } catch (error) {
        console.error('Error fetching mentor connections:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// NEW: Route to allow a mentor to revoke a mentorship connection
router.delete('/connections/:requestId', verifyToken, checkRole('mentor'), async (req, res) => {
    const { requestId } = req.params;
    const mentorId = req.user.uid;

    try {
        const requestRef = db.collection('mentorRequests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists) {
            return res.status(404).json({ message: 'Mentorship request not found.' });
        }
        
        const data = requestDoc.data();
        // Crucial check: Ensure the mentor making the request is the mentor in the document
        if (data.mentorId !== mentorId) {
            return res.status(403).json({ message: 'Unauthorized. You can only revoke your own connections.' });
        }

        const menteeId = data.menteeId;
        const menteeRef = db.collection('users').doc(menteeId);
        const mentorRef = db.collection('users').doc(mentorId);

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

        // 4. Create a notification for the mentee
        const notificationRef = db.collection('notifications').doc();
        batch.set(notificationRef, {
            recipientId: menteeId,
            senderId: mentorId,
            type: 'mentorship_revoked',
            message: `${mentorDoc.data()?.firstName} has ended your mentorship connection.`,
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        
        await batch.commit();

        res.status(200).json({ message: 'Mentorship connection successfully revoked.' });
    } catch (error) {
        console.error('Error revoking mentorship:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

export default router;