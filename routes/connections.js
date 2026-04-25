// backend/routes/connections.js

import express from 'express';
import admin from 'firebase-admin';
import verifyToken from '../middleware/auth.js';

const router = express.Router();
const db = admin.firestore();

// Endpoint to get all connections and pending requests for the logged-in user
// **UPDATED** to include requests the current user has SENT.
router.get('/', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;

        // 1. Get accepted connections (No change)
        const userDoc = await db.collection('users').doc(userId).get();
        const connectionsIds = userDoc.data()?.connections || [];

        let acceptedConnections = [];
        if (connectionsIds.length > 0) {
            const usersSnapshot = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', connectionsIds).get();
            acceptedConnections = usersSnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
        }

        // 2. Get pending requests sent TO the user (No change)
        const pendingRequests = await db.collection('connectionRequests')
            .where('recipientId', '==', userId)
            .where('status', '==', 'pending')
            .get();

        const pendingRequestsData = await Promise.all(pendingRequests.docs.map(async (doc) => {
            const data = doc.data();
            const senderDoc = await db.collection('users').doc(data.senderId).get();
            return {
                requestId: doc.id,
                sender: {
                    id: senderDoc.id,
                    ...senderDoc.data()
                },
                status: data.status,
                createdAt: data.createdAt?.toDate().toISOString(),
            };
        }));

        // 3. Get pending requests sent FROM the user (**NEW LOGIC**)
        const sentRequests = await db.collection('connectionRequests')
            .where('senderId', '==', userId)
            .where('status', '==', 'pending')
            .get();

        const sentRequestsData = await Promise.all(sentRequests.docs.map(async (doc) => {
            const data = doc.data();
            const recipientDoc = await db.collection('users').doc(data.recipientId).get();
            return {
                requestId: doc.id, // Optional, but good to keep
                recipient: { // Must return the recipient's details for the frontend filter
                    id: recipientDoc.id,
                    ...recipientDoc.data()
                },
                status: data.status,
                createdAt: data.createdAt?.toDate().toISOString(),
            };
        }));
        
        // Return all three lists of connection data
        res.status(200).json({ 
            acceptedConnections, 
            pendingRequests: pendingRequestsData,
            sentRequests: sentRequestsData // <--- ADDED TO RESPONSE
        });
    } catch (error) {
        console.error('Error fetching connections:', error);
        res.status(500).json({ message: 'Server error.' });
    }
});


// Endpoint to send a connection request (Notification Added)
router.post('/request/:recipientId', verifyToken, async (req, res) => {
    try {
        const senderId = req.user.uid;
        const recipientId = req.params.recipientId;

        if (senderId === recipientId) {
            return res.status(400).json({ message: 'You cannot send a connection request to yourself.' });
        }

        // Check if a request already exists (sender -> recipient)
        const existingRequest = await db.collection('connectionRequests')
            .where('senderId', '==', senderId)
            .where('recipientId', '==', recipientId)
            .where('status', '==', 'pending')
            .get();

        if (!existingRequest.empty) {
            return res.status(409).json({ message: 'A pending connection request already exists.' });
        }
        
        // Also check if they are already connected
        const senderDoc = await db.collection('users').doc(senderId).get();
        const senderConnections = senderDoc.data()?.connections || [];
        if (senderConnections.includes(recipientId)) {
            return res.status(409).json({ message: 'You are already connected with this user.' });
        }
        
        // Fetch sender's name for the notification
        const senderData = senderDoc.data();
        const senderName = senderData?.firstName || 'A user';

        const newRequest = {
            senderId,
            recipientId,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const docRef = await db.collection('connectionRequests').add(newRequest);
        
        // --- 🏆 NEW: Send Notification to Recipient ---
        await db.collection('notifications').add({
            userId: recipientId,
            type: 'CONNECTION_REQUEST', // ✅ NEW Notification Type
            message: `${senderName} wants to connect with you!`,
            relatedEntityId: docRef.id, // ID of the request document
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // ------------------------------------------------

        res.status(201).json({ message: 'Connection request sent successfully.' });
    } catch (error) {
        console.error('Error sending connection request:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Endpoint to accept a connection request (Notification Added)
router.put('/accept/:requestId', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const requestId = req.params.requestId;

        const requestRef = db.collection('connectionRequests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists || requestDoc.data().recipientId !== userId) {
            return res.status(403).json({ message: 'Unauthorized or request not found.' });
        }

        const { senderId, recipientId } = requestDoc.data();
        const batch = db.batch();

        // 1. Update the request status
        batch.update(requestRef, { status: 'accepted' });

        // 2. Add each user to the other's connections array
        const senderRef = db.collection('users').doc(senderId);
        const recipientRef = db.collection('users').doc(recipientId);

        batch.update(senderRef, { connections: admin.firestore.FieldValue.arrayUnion(recipientId) });
        batch.update(recipientRef, { connections: admin.firestore.FieldValue.arrayUnion(senderId) });

        // Execute batch update
        await batch.commit();
        
        // --- 🏆 NEW: Send Notification to Sender (The one who is accepted) ---
        // Fetch recipient's name for the notification
        const recipientDoc = await recipientRef.get();
        const recipientData = recipientDoc.data();
        const recipientName = recipientData?.firstName || 'A user';

        await db.collection('notifications').add({
            userId: senderId, // Notify the sender of the original request
            type: 'CONNECTION_ACCEPTED', // ✅ NEW Notification Type
            message: `${recipientName} accepted your connection request!`,
            relatedEntityId: recipientId, // The ID of the new connection (the recipient)
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // ------------------------------------------------

        res.status(200).json({ message: 'Connection request accepted.' });
    } catch (error) {
        console.error('Error accepting connection:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Endpoint to decline a connection request (No notification needed for decline)
router.put('/decline/:requestId', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const requestId = req.params.requestId;

        const requestRef = db.collection('connectionRequests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists || requestDoc.data().recipientId !== userId) {
            return res.status(403).json({ message: 'Unauthorized or request not found.' });
        }

        await requestRef.update({ status: 'declined' });
        res.status(200).json({ message: 'Connection request declined.' });
    } catch (error) {
        console.error('Error declining connection:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

export default router;