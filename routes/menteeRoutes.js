import express from 'express';
import { admin } from '../config/firebase-config.js'; 
import verifyToken from '../middleware/auth.js'; 

const router = express.Router();
const db = admin.firestore();

router.get('/requests', verifyToken, async (req, res) => {
    const menteeId = req.user.uid;

    try {
        const requestsSnapshot = await db.collection('mentorRequests')
            .where('menteeId', '==', menteeId)
            .get();

        const requests = await Promise.all(requestsSnapshot.docs.map(async (doc) => {
            const requestData = doc.data();
            const mentorDoc = await db.collection('users').doc(requestData.mentorId).get();
            const mentorName = mentorDoc.data()?.firstName || 'A mentor';

            return {
                id: doc.id,
                ...requestData,
                mentorName,
                createdAt: requestData.createdAt.toDate().toISOString(),
            };
        }));

        res.status(200).json(requests);
    } catch (error) {
        console.error('Error fetching mentee requests:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

export default router;