import express from 'express';
import admin from 'firebase-admin';
import verifyToken from '../middleware/auth.js';

const router = express.Router();
const db = admin.firestore();

// Endpoint to get all groups a user is a member of
router.get('/my/:userId', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params; // Get the ID from the URL parameter

        // It's a good practice to authorize the request
        if (req.user.uid !== userId) {
            return res.status(403).json({ message: 'Forbidden: You can only view your own groups.' });
        }

        const groupsSnapshot = await db.collection('groups')
            .where('members', 'array-contains', userId)
            .get();

        const groups = groupsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.status(200).json({ groups });
    } catch (error) {
        console.error("Error fetching user's groups:", error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// Endpoint to get all groups and pending requests sent by the user
router.get('/all', verifyToken, async (req, res) => {
    try {
        const allGroupsSnapshot = await db.collection('groups').get();
        const groups = allGroupsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        // Fetch pending group join requests for the current user
        const sentRequestsSnapshot = await db.collection('group_requests')
            .where('senderId', '==', req.user.uid)
            .where('status', '==', 'pending')
            .get();

        const sentRequests = sentRequestsSnapshot.docs.map(doc => doc.data().groupId);

        res.status(200).json({ groups, sentRequests });
    } catch (error) {
        console.error('Error fetching all groups:', error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// Endpoint to create a new group
router.post('/create', verifyToken, async (req, res) => {
    try {
        const { groupName, memberIds } = req.body;
        const ownerId = req.user.uid;

        if (!groupName || !Array.isArray(memberIds) || memberIds.length === 0) {
            return res.status(400).json({ message: 'Group name and at least one member are required.' });
        }

        if (!memberIds.includes(ownerId)) {
            memberIds.push(ownerId);
        }

        const newGroup = {
            name: groupName,
            members: memberIds,
            owner: ownerId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const groupRef = await db.collection('groups').add(newGroup);
        res.status(201).json({ groupId: groupRef.id, message: 'Group created successfully.' });
    } catch (error) {
        console.error('Error creating group:', error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// New endpoint to get pending join requests for groups owned by the user.
router.get('/requests', verifyToken, async (req, res) => {
    try {
        const ownerId = req.user.uid;

        // 1. Find all groups where the current user is the owner
        const ownedGroupsSnapshot = await db.collection('groups')
            .where('owner', '==', ownerId)
            .get();

        const ownedGroupIds = ownedGroupsSnapshot.docs.map(doc => doc.id);

        if (ownedGroupIds.length === 0) {
            return res.status(200).json({ requests: [] });
        }

        // 2. Find all pending requests for these groups
        const pendingRequestsSnapshot = await db.collection('group_requests')
            .where('groupId', 'in', ownedGroupIds)
            .where('status', '==', 'pending')
            .get();

        // 3. Get details for the senders and group names
        const requests = [];
        for (const doc of pendingRequestsSnapshot.docs) {
            const requestData = doc.data();
            const senderId = requestData.senderId;
            const groupId = requestData.groupId;

            // Fetch sender's user details
            const senderDoc = await db.collection('users').doc(senderId).get();
            const senderData = senderDoc.data();

            // Find group details from the previously fetched ownedGroupsSnapshot
            const groupDoc = ownedGroupsSnapshot.docs.find(d => d.id === groupId);
            const groupData = groupDoc.data();

            if (senderData && groupData) {
                requests.push({
                    requestId: doc.id,
                    sender: {
                        id: senderDoc.id,
                        firstName: senderData.firstName,
                        lastName: senderData.lastName,
                        avatar: senderData.avatar,
                    },
                    group: {
                        id: groupDoc.id,
                        name: groupData.name,
                    },
                    createdAt: requestData.createdAt,
                });
            }
        }

        res.status(200).json({ requests });
    } catch (error) {
        console.error('Error fetching group join requests:', error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// New endpoint to approve a join request
router.put('/requests/:requestId/approve', verifyToken, async (req, res) => {
    try {
        const { requestId } = req.params;
        const ownerId = req.user.uid;

        const requestRef = db.collection('group_requests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists || requestDoc.data().status !== 'pending') {
            return res.status(404).json({ message: 'Request not found or already processed.' });
        }

        const requestData = requestDoc.data();
        const groupRef = db.collection('groups').doc(requestData.groupId);
        const groupDoc = await groupRef.get();
        const groupData = groupDoc.data();

        // Authorization check: ensure the current user owns the group
        if (groupData.owner !== ownerId) {
            return res.status(403).json({ message: 'You do not have permission to approve this request.' });
        }

        // Add the sender to the group's members array
        const newMembers = [...groupData.members, requestData.senderId];
        await groupRef.update({ members: newMembers });

        // Update the request status
        await requestRef.update({ status: 'approved' });

        res.status(200).json({ message: 'Join request approved successfully.' });
    } catch (error) {
        console.error('Error approving join request:', error);
        res.status(500).json({ message: 'Server error.' });
    }
});


// New endpoint to decline a join request
router.put('/requests/:requestId/decline', verifyToken, async (req, res) => {
    try {
        const { requestId } = req.params;
        const ownerId = req.user.uid;

        const requestRef = db.collection('group_requests').doc(requestId);
        const requestDoc = await requestRef.get();

        if (!requestDoc.exists || requestDoc.data().status !== 'pending') {
            return res.status(404).json({ message: 'Request not found or already processed.' });
        }

        const requestData = requestDoc.data();
        const groupRef = db.collection('groups').doc(requestData.groupId);
        const groupDoc = await groupRef.get();
        const groupData = groupDoc.data();

        // Authorization check: ensure the current user owns the group
        if (groupData.owner !== ownerId) {
            return res.status(403).json({ message: 'You do not have permission to decline this request.' });
        }

        // Update the request status
        await requestRef.update({ status: 'declined' });

        res.status(200).json({ message: 'Join request declined successfully.' });
    } catch (error) {
        console.error('Error declining join request:', error);
        res.status(500).json({ message: 'Server error.' });
    }
});


// Endpoint to request to join a group
router.post('/:groupId/join', verifyToken, async (req, res) => {
    try {
        const { groupId } = req.params;
        const userId = req.user.uid;

        // Check if the user is already a member of the group
        const groupRef = db.collection('groups').doc(groupId);
        const groupDoc = await groupRef.get();
        if (!groupDoc.exists) {
            return res.status(404).json({ message: 'Group not found.' });
        }

        const groupData = groupDoc.data();
        if (groupData.members && groupData.members.includes(userId)) {
            return res.status(409).json({ message: 'You are already a member of this group.' });
        }

        // Check if a pending request already exists
        const existingRequest = await db.collection('group_requests')
            .where('groupId', '==', groupId)
            .where('senderId', '==', userId)
            .where('status', '==', 'pending')
            .get();

        if (!existingRequest.empty) {
            return res.status(409).json({ message: 'A join request is already pending for this group.' });
        }

        // Create a new join request
        const newRequest = {
            groupId,
            senderId: userId,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await db.collection('group_requests').add(newRequest);

        res.status(200).json({ message: 'Join request sent successfully.' });
    } catch (error) {
        console.error('Error sending group join request:', error);
        res.status(500).json({ message: 'Server error.' });
    }
});

// Endpoint to get a single group by its ID
// This route is placed last to avoid conflicts
router.get('/:groupId', verifyToken, async (req, res) => {
    try {
        const { groupId } = req.params;
        const groupRef = db.collection('groups').doc(groupId);
        const doc = await groupRef.get();

        if (!doc.exists) {
            return res.status(404).json({ message: 'Group not found.' });
        }

        const groupData = {
            id: doc.id,
            ...doc.data(),
        };

        res.status(200).json(groupData);
    } catch (error) {
        console.error('Error fetching group by ID:', error);
        res.status(500).json({ message: 'Server error.' });
    }
});

export default router;