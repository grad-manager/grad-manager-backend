import express from 'express';
import { admin } from '../config/firebase-config.js';
import verifyToken from '../middleware/auth.js';
import { createNotification } from './notificationRoutes.js';
import { notifyUser } from '../services/notificationService.js';
import { getEffectivePlan } from '../utils/trial.js';

const router = express.Router();
const db = admin.firestore();

// Helper function to check for admin role
const isAdmin = async (uid) => {
    try {
        const userDoc = await db.collection('users').doc(uid).get();
        const role = userDoc.data()?.role;
        return userDoc.exists && role === 'admin';
    } catch (error) {
        console.error("Error checking admin role:", error); 
        return false;
    }
};

// Helper function to check if the user has a Pro plan for notifications
const hasNotificationPermission = async (uid) => {
    try {
        const userDoc = await db.collection('users').doc(uid).get();
        const userData = userDoc.data();
        const effectivePlan = getEffectivePlan(userData, { defaultPlan: 'Free', trialPlan: 'Pro' });
        const p = normalizePlan(effectivePlan);
        return userDoc.exists && p === 'Pro';
    } catch (error) {
        console.error("Error checking user plan:", error);
        return false;
    }
};

// Normalize plan string to canonical values used across the app
const normalizePlan = (plan) => {
    if (!plan) return 'Free';
    const p = String(plan).trim().toLowerCase();
    if (p === 'pro') return 'Pro';
    if (p === 'premium') return 'Pro';
    // Treat 'basic' and 'free' as the same lowest tier for project limits
    return 'Free';
};

// Helper function to define project limits based on plan
const getPlanProjectLimit = (plan) => {
    const p = normalizePlan(plan);
    switch (p) {
        case 'Free':
            return 1; // Free users can join/create 1 project
        case 'Pro':
            return Infinity; // Unlimited projects for Pro plan
        default:
            return 1;
    }
};

// Route to create a new project
// Accessible by all users, but requires admin approval
router.post('/', verifyToken, async (req, res) => {
    const { title, goals, description } = req.body;
    const userId = req.user.uid;

    if (!title || !goals || !description) {
        return res.status(400).json({ message: 'Project title, goals, and description are required.' });
    }

    try {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User profile not found.' });
        }

        const userData = userDoc.data();
        const userName = userData.firstName && userData.lastName ? `${userData.firstName} ${userData.lastName}` : 'A user';

        // Check the user's plan limit before creating the project
        const userPlan = getEffectivePlan(userData, { defaultPlan: 'Free', trialPlan: 'Pro' });
        const currentProjectCount = userData.projectCount || 0;
        const maxProjects = getPlanProjectLimit(userPlan);

        if (maxProjects !== Infinity && currentProjectCount >= maxProjects) {
            return res.status(403).json({
                message: `You have reached the limit of ${maxProjects} projects allowed on your ${userPlan} plan. Please upgrade to create more projects.`,
                upgradeRequired: true
            });
        }

        const adminSnapshot = await db.collection('users').where('role', '==', 'admin').limit(1).get();
        const adminId = adminSnapshot.docs[0]?.id;
        if (!adminId) {
            return res.status(500).json({ message: 'Admin user not found.' });
        }

        // Create a new project document and increment the creator's projectCount atomically
        const newProjectRef = db.collection('projects').doc();
        const newProjectData = {
            title,
            goals,
            description,
            creatorId: userId,
            creatorName: userName,
            status: 'pending_approval',
            members: [],
            pendingRequests: [{
                userId,
                userName,
                requestedAt: new Date()
            }],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        await db.runTransaction(async (transaction) => {
            transaction.set(newProjectRef, newProjectData);
            transaction.update(userRef, {
                projectCount: admin.firestore.FieldValue.increment(1)
            });
        });

        const notificationMessage = `A new project "${title}" has been created by ${userName} and is pending your approval.`;
        await createNotification(adminId, userId, notificationMessage, 'project_approval_request');

        res.status(201).json({
            message: 'Project created successfully and is awaiting admin approval.',
            projectId: newProjectRef.id,
        });
    } catch (error) {
        console.error('Error creating project:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Admin route to approve a project
router.put('/:projectId/approve', verifyToken, async (req, res) => {
    if (!await isAdmin(req.user.uid)) {
        return res.status(403).json({ message: 'Forbidden: Only administrators can approve projects.' });
    }

    const { projectId } = req.params;

    try {
        const projectRef = db.collection('projects').doc(projectId);
        const projectDoc = await projectRef.get();

        if (!projectDoc.exists) {
            return res.status(404).json({ message: 'Project not found.' });
        }

        const projectData = projectDoc.data();
        const creatorId = projectData.creatorId;

        await projectRef.update({
            status: 'active',
            members: [creatorId], // Add the creator as the first member
            pendingRequests: [],
            approvedBy: req.user.uid,
            approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const notificationMessage = `Your project "${projectData.title}" has been approved and is now active!`;
        await createNotification(creatorId, req.user.uid, notificationMessage, 'project_approved');

        res.status(200).json({ message: 'Project approved successfully.' });
    } catch (error) {
        console.error('Error approving project:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Admin route to decline a project
router.put('/:projectId/decline', verifyToken, async (req, res) => {
    if (!await isAdmin(req.user.uid)) {
        return res.status(403).json({ message: 'Forbidden: Only administrators can decline projects.' });
    }

    const { projectId } = req.params;

    try {
        const projectRef = db.collection('projects').doc(projectId);
        const projectDoc = await projectRef.get();

        if (!projectDoc.exists) {
            return res.status(404).json({ message: 'Project not found.' });
        }

        // Update project status and decrement creator's projectCount (if present)
        const projectData = projectDoc.data();
        const creatorId = projectData.creatorId;

        await db.runTransaction(async (transaction) => {
            transaction.update(projectRef, {
                status: 'declined',
                declinedBy: req.user.uid,
                declinedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            if (creatorId) {
                const creatorRef = db.collection('users').doc(creatorId);
                transaction.update(creatorRef, {
                    projectCount: admin.firestore.FieldValue.increment(-1)
                });
            }
        });

        const notificationMessage = `Your project "${projectData.title}" has been declined by an admin.`;
        await createNotification(projectData.creatorId, req.user.uid, notificationMessage, 'project_declined');

        res.status(200).json({ message: 'Project declined successfully.' });
    } catch (error) {
        console.error('Error declining project:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Route to get a list of all active projects
router.get('/', verifyToken, async (req, res) => {
    try {
        const projectsSnapshot = await db.collection('projects')
            .where('status', '==', 'active')
            .get();

        const projects = projectsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
        }));

        res.status(200).json(projects);
    } catch (error) {
        console.error('Error fetching projects:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Route to send a request to join a project
router.post('/:projectId/join-request', verifyToken, async (req, res) => {
    const { projectId } = req.params;
    const userId = req.user.uid;

    try {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
             return res.status(404).json({ message: 'User profile not found.' });
        }
        
        const userData = userDoc.data();
        const userPlan = getEffectivePlan(userData, { defaultPlan: 'Free', trialPlan: 'Pro' });
        // IMPORTANT: We treat the "pending" state as already using up a slot.
        const currentProjectCount = userData.projectCount || 0; 
        const maxProjects = getPlanProjectLimit(userPlan);

        // 🛑 NEW: CHECK SUBSCRIPTION LIMITS
        if (maxProjects !== Infinity && currentProjectCount >= maxProjects) {
            return res.status(403).json({ 
                message: `You have reached the limit of ${maxProjects} projects allowed on your ${normalizePlan(userPlan)} plan. Please upgrade to join more projects.`,
                upgradeRequired: true
            });
        }
        // ---------------------------------

        const projectRef = db.collection('projects').doc(projectId);
        const projectDoc = await projectRef.get();

        if (!projectDoc.exists) {
            return res.status(404).json({ message: 'Project not found.' });
        }

        const projectData = projectDoc.data();
        const isMember = projectData.members && projectData.members.includes(userId);
        const hasPendingRequest = projectData.pendingRequests && projectData.pendingRequests.some(request => request.userId === userId); 

        if (isMember) {
            return res.status(409).json({ message: 'You are already a member of this project.' });
        }
        if (hasPendingRequest) {
            return res.status(409).json({ message: 'You have a pending request to join this project.' });
        }

        const userName = userData.firstName && userData.lastName ? 
                            `${userData.firstName} ${userData.lastName}` : 
                            'A user';
        
        // ✅ FIX: Use new Date() instead of FieldValue.serverTimestamp() when
        // the object is being added to an array using arrayUnion.
        const newPendingRequest = {
            userId,
            userName,
            requestedAt: new Date(), 
        };

        // ✅ NEW: Use transaction to update both project and user data atomically
        await db.runTransaction(async (transaction) => {
            // Update project's pending requests
            transaction.update(projectRef, {
                pendingRequests: admin.firestore.FieldValue.arrayUnion(newPendingRequest),
            });

            // Increment user's project count, as the request is now pending
            transaction.update(userRef, {
                projectCount: admin.firestore.FieldValue.increment(1) 
            });
        });

        const creatorId = projectData.creatorId;
        if (creatorId) {
            const notificationMessage = `${userName} has requested to join your project "${projectData.title}".`;
            await createNotification(creatorId, userId, notificationMessage, 'project_join_request');
        }

        res.status(200).json({ message: 'Join request sent successfully.' });
    } catch (error) {
        console.error('Error sending join request:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Admin route to get a list of all pending projects (Admin only)
router.get('/pending', verifyToken, async (req, res) => {
    if (!await isAdmin(req.user.uid)) {
        return res.status(403).json({ message: 'Forbidden: Only administrators can view pending projects.' });
    }
    
    try {
        const projectsSnapshot = await db.collection('projects')
            .where('status', '==', 'pending_approval')
            .orderBy('createdAt', 'asc')
            .get();

        const projects = projectsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate(),
        }));

        res.status(200).json(projects);
    } catch (error) {
        console.error('Error fetching pending projects:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Admin route to delete a project
router.delete('/:projectId', verifyToken, async (req, res) => {
    if (!await isAdmin(req.user.uid)) {
        return res.status(403).json({ message: 'Forbidden: Only administrators can delete projects.' });
    }

    const { projectId } = req.params;

    try {
        const projectRef = db.collection('projects').doc(projectId);
        await projectRef.delete();
        res.status(200).json({ message: 'Project deleted successfully.' });
    } catch (error) {
        console.error('Error deleting project:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Admin route to get all pending join requests
router.get('/join-requests/pending', verifyToken, async (req, res) => {
    if (!await isAdmin(req.user.uid)) {
        return res.status(403).json({ message: 'Forbidden: Only administrators can view join requests.' });
    }

    try {
        const projectsSnapshot = await db.collection('projects')
            .where('pendingRequests', '!=', []) // Find projects with pending requests
            .get();

        const pendingRequests = [];
        projectsSnapshot.docs.forEach(doc => {
            const projectData = doc.data();
            // Ensure pendingRequests is an array before iterating
            if (Array.isArray(projectData.pendingRequests)) {
                projectData.pendingRequests.forEach(request => {
                    pendingRequests.push({
                        userId: request.userId,
                        userName: request.userName,
                        projectId: doc.id,
                        projectTitle: projectData.title,
                        requestedAt: request.requestedAt,
                    });
                });
            }
        });

        res.status(200).json(pendingRequests);
    } catch (error) {
        console.error('Error fetching pending join requests:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Admin route to approve a join request
router.put('/:projectId/join-requests/approve', verifyToken, async (req, res) => {
    if (!await isAdmin(req.user.uid)) {
        return res.status(403).json({ message: 'Forbidden: Only administrators can approve join requests.' });
    }

    const { projectId } = req.params;
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ message: 'User ID is required.' });
    }

    try {
        const projectRef = db.collection('projects').doc(projectId);
        const projectDoc = await projectRef.get();

        if (!projectDoc.exists) {
            return res.status(404).json({ message: 'Project not found.' });
        }

        const projectData = projectDoc.data();
        const pendingRequests = projectData.pendingRequests || [];
        const requestToApprove = pendingRequests.find(r => r.userId === userId);

        if (!requestToApprove) {
            return res.status(404).json({ message: 'Join request not found.' });
        }

        const newPendingRequests = pendingRequests.filter(r => r.userId !== userId);

        // NOTE: We do not need a transaction here to update projectCount
        // because projectCount was already incremented when the request was sent.
        // We only remove the request and add the member.
        await projectRef.update({
            members: admin.firestore.FieldValue.arrayUnion(userId),
            pendingRequests: newPendingRequests,
        });

        // Notify the user who made the request
        const notificationMessage = `Your request to join "${projectData.title}" has been approved! You are now a member.`;
        await createNotification(userId, req.user.uid, notificationMessage, 'join_request_approved');

        res.status(200).json({ message: 'Join request approved successfully.' });
    } catch (error) {
        console.error('Error approving join request:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Admin route to decline a join request
router.put('/:projectId/join-requests/decline', verifyToken, async (req, res) => {
    if (!await isAdmin(req.user.uid)) {
        return res.status(403).json({ message: 'Forbidden: Only administrators can decline join requests.' });
    }

    const { projectId } = req.params;
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ message: 'User ID is required.' });
    }

    try {
        const projectRef = db.collection('projects').doc(projectId);
        const projectDoc = await projectRef.get();

        if (!projectDoc.exists) {
            return res.status(404).json({ message: 'Project not found.' });
        }

        const projectData = projectDoc.data();
        const pendingRequests = projectData.pendingRequests || [];
        const requestToDecline = pendingRequests.find(r => r.userId === userId);

        if (!requestToDecline) {
            return res.status(404).json({ message: 'Join request not found.' });
        }

        const newPendingRequests = pendingRequests.filter(r => r.userId !== userId);
        const userRef = db.collection('users').doc(userId);

        // ✅ NEW: Use transaction to update both project and user data atomically
        await db.runTransaction(async (transaction) => {
            // 1. Update project: remove the request
            transaction.update(projectRef, {
                pendingRequests: newPendingRequests,
            });

            // 2. Update user: decrement the project count
            transaction.update(userRef, {
                projectCount: admin.firestore.FieldValue.increment(-1)
            });
        });

        // Notify the user who made the request
        const notificationMessage = `Your request to join "${projectData.title}" has been declined by an admin.`;
        await createNotification(userId, req.user.uid, notificationMessage, 'join_request_declined');

        res.status(200).json({ message: 'Join request declined successfully.' });
    } catch (error) {
        console.error('Error declining join request:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Admin route to get all projects (pending and active)
router.get('/all', verifyToken, async (req, res) => {
    if (!await isAdmin(req.user.uid)) {
        return res.status(403).json({ message: 'Forbidden: Only administrators can view all projects.' });
    }

    try {
        const projectsSnapshot = await db.collection('projects')
            .orderBy('createdAt', 'desc')
            .get();

        const projects = projectsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            createdAt: doc.data().createdAt?.toDate(),
        }));

        res.status(200).json(projects);
    } catch (error) {
        console.error('Error fetching all projects:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Admin route to remove a member from an active project
router.put('/:projectId/remove-member', verifyToken, async (req, res) => {
    if (!await isAdmin(req.user.uid)) {
        return res.status(403).json({ message: 'Forbidden: Only administrators can remove project members.' });
    }

    const { projectId } = req.params;
    const { memberId } = req.body;

    if (!memberId) {
        return res.status(400).json({ message: 'Member ID is required.' });
    }

    try {
        const projectRef = db.collection('projects').doc(projectId);
        const projectDoc = await projectRef.get(); // Fetch doc to get title for notification

        if (!projectDoc.exists) {
            return res.status(404).json({ message: 'Project not found.' });
        }
        
        const projectTitle = projectDoc.data().title; // Get project title
        
        await projectRef.update({
            members: admin.firestore.FieldValue.arrayRemove(memberId)
        });

        // ✅ FIX: Notify the removed user
        const notificationMessage = `You have been removed from the project "${projectTitle}" by an administrator.`;
        await createNotification(memberId, req.user.uid, notificationMessage, 'member_removed');

        res.status(200).json({ message: 'Member removed successfully.' });
    } catch (error) {
        console.error('Error removing project member:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// Route to get user details by a list of UIDs
router.post('/users/get-by-ids', verifyToken, async (req, res) => {
    const { uids } = req.body;
    if (!uids || !Array.isArray(uids) || uids.length === 0) {
        return res.status(400).json({ message: 'A non-empty array of user IDs is required.' });
    }

    try {
        const users = [];
        const usersSnapshot = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', uids).get();
        usersSnapshot.forEach(doc => {
            const userData = doc.data();
            users.push({
                uid: doc.id,
                firstName: userData.firstName,
                lastName: userData.lastName
            });
        });
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching users by IDs:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// === Broadcast idea notification to all project members except sender ===
// **Subscription Guard Applied:** Requires Pro plan.
router.post("/:projectId/notify", verifyToken, async (req, res) => {
    const senderId = req.user.uid;

    // **Subscription Plan Check:** Enforces Pro access
    if (!await hasNotificationPermission(senderId)) {
        return res.status(403).json({ 
            error: "Forbidden: This feature requires a Pro subscription plan." 
        });
    }
    // **End Subscription Plan Check**

    try {
        const { projectId } = req.params;
        // The frontend sends senderName and content
        const { senderName, content } = req.body; 

        if (!senderName || !content)
            return res.status(400).json({ error: "Missing senderName or content" });

        // 1. Get project members from Firestore
        const projectDoc = await db.collection("projects").doc(projectId).get();
        if (!projectDoc.exists)
            return res.status(404).json({ error: "Project not found" });

        const projectData = projectDoc.data();
        const members = projectData.members || [];

        // 2. Identify recipients (all members except sender)
        const targets = members.filter((uid) => uid !== senderId);

        // Determine the notification title (use project title for context)
        const title = `New idea in "${projectData.title}"`; 
        // 3. Send Notifications (in-app + push)
        const notifyPromises = [];
        for (const uid of targets) {
            const notifyPromise = notifyUser(uid, {
                senderId,
                pushTitle: title,
                pushBody: `${senderName}: ${content}`,
                pushUrl: `/projects/${projectId}`,
                type: 'PROJECT_MESSAGE',
                relatedEntityId: projectId,
                metadata: { projectId },
            }).catch((err) => {
                console.error(`[notifyUser] Error sending to ${uid}:`, err);
                return null;
            });
            notifyPromises.push(notifyPromise);
        }

        await Promise.allSettled(notifyPromises);

        res.status(200).json({ message: "Notification process initiated 🚀" });
    } catch (error) {
        console.error("[/:projectId/notify] Error:", error);
        res.status(500).json({ error: "Failed to send project notification" });
    }
});

export default router;
