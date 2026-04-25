// src/middleware/authMiddleware.js 
// (or src/middleware/auth.js, if you keep the original name)

// Make sure you have 'firebase-admin' installed and the SDK initialized in your index.js
import admin from 'firebase-admin';
import { isTrialActive } from '../utils/trial.js';

// 🚨 Initialize the database client (assuming Firestore)
const db = admin.firestore(); 

const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Authentication token is required.' });
    }

    const token = authHeader.split(' ')[1];

    console.log('Token received (first 10 chars):', token ? token.substring(0, 10) + '...' : 'NULL');
    console.log('Token length:', token ? token.length : 0);

    try {
        // 1. Verify the Firebase ID Token.
        const decodedToken = await admin.auth().verifyIdToken(token);
        const uid = decodedToken.uid;

        // 2. 🔑 CRITICAL ADDITION: Fetch the full user document from Firestore.
        // This is necessary to get 'applicationsCount' and 'subscription.plan'.
        const userDocRef = db.collection('users').doc(uid); 
        const userDoc = await userDocRef.get();

        if (!userDoc.exists) {
            console.error(`User document not found for UID: ${uid}`);
            return res.status(403).json({ message: 'User profile not found in database.' });
        }
        
        const userData = userDoc.data();
        const role = decodedToken.role || userData.role || 'user'; // Use token role, DB role, or default

        // 3. Attach the full, enriched user object to the request.
        req.user = { 
            // Merge decoded token data with fetched DB data
            ...userData, 
            uid: uid, 
            firebaseUid: uid,
            email: decodedToken.email, 
            role: role,
            trialActive: isTrialActive(userData.trial)
        };
        
        // Also attach uid directly, commonly used in controllers
        req.uid = uid; 
        
        next();
    } catch (error) {
        console.error('Firebase Auth Token verification error:', error.message);
        // The error could be 'auth/id-token-expired' or 'auth/argument-error'
        return res.status(403).json({ message: 'Invalid or expired token.' });
    }
};

// 🚨 Maintaining your requested export default pattern
export default verifyToken;
