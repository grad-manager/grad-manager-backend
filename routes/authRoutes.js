import { Router } from 'express';
import admin from 'firebase-admin';

const router = Router();
const db = admin.firestore();

// Endpoint for Firebase email/password registration
// Automatically assigns the 'user' role
router.post('/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    // Helper to get first/last name from a single name field (assuming space separation)
    const [firstName, ...lastNameParts] = (name || 'User').split(' ');
    const lastName = lastNameParts.join(' ');
    
    try {
        // Create the user in Firebase Auth
        const userRecord = await admin.auth().createUser({ email, password, displayName: name });
        
        // 🚨 CRITICAL: Set the 'user' role as a custom claim on the Firebase user object
        await admin.auth().setCustomUserClaims(userRecord.uid, { role: 'user' });

        const trial = {
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        };

        // Save the user's data to Firestore with the default 'user' role
        await db.collection('users').doc(userRecord.uid).set({
            firebaseUid: userRecord.uid,
            email: userRecord.email,
            name: userRecord.displayName,
            // 🚨 NEW/UPDATED PROFILE FIELDS 🚨
            firstName: firstName || 'User',
            lastName: lastName || '',
            photoURL: null,
            gender: null,
            bio: null,
            // ---------------------------------
            mentorId: null,
            isConnectedToMentor: false,
            role: 'user', // Always assign 'user' as the default role
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            trial,
            notificationSettings: {
                email: true,
                push: false
            }
        });

        res.status(201).json({ message: 'User registered successfully.' });
    } catch (error) {
        console.error('Error during user registration:', error);
        if (error.code === 'auth/email-already-in-use') {
            return res.status(409).json({ message: 'The email address is already in use.' });
        }
        res.status(500).json({ message: 'Failed to register user.', error });
    }
});

// Endpoint for all Firebase logins (email/password, Google, etc.)
router.post('/firebase-login', async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) {
        return res.status(400).json({ message: 'ID token is required.' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const { uid, email, name, picture } = decodedToken; // Added 'picture'
        
        const userDocRef = db.collection('users').doc(uid);
        const userDoc = await userDocRef.get();

        if (!userDoc.exists) {
            // Document does not exist, create it with all default fields
            const [firstName, ...lastNameParts] = (name || 'User').split(' ');
            const lastName = lastNameParts.join(' ');

            const trial = {
                startDate: new Date().toISOString(),
                endDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            };

            await userDocRef.set({
                firebaseUid: uid,
                email: email,
                name: name || 'User',
                // 🚨 NEW/UPDATED PROFILE FIELDS 🚨
                firstName: firstName || 'User',
                lastName: lastName || '',
                photoURL: picture || null, // Use Firebase's picture if available (e.g., from Google login)
                gender: null,
                bio: null,
                // ---------------------------------
                mentorId: null,
                isConnectedToMentor: false,
                role: 'user', // Assign 'user' as the default role
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                trial,
                notificationSettings: {
                    email: true,
                    push: false
                }
            });

            // 🚨 CRITICAL: Set the 'user' role as a custom claim for new sign-ins
            await admin.auth().setCustomUserClaims(uid, { role: 'user' });
            
        } else {
            // Document exists, update a field and ensure the custom role is set
            const userProfile = userDoc.data();
            await userDocRef.update({
                lastLogin: admin.firestore.FieldValue.serverTimestamp(),
                // NOTE: We don't overwrite firstName, lastName, photoURL here 
                // if they are already set by the user during the profile setup.
            });

            // 🚨 CRITICAL: Ensure the custom role is set for existing users
            await admin.auth().setCustomUserClaims(uid, { role: userProfile.role });
        }

        const updatedUserDoc = await userDocRef.get();
        const userProfile = updatedUserDoc.data();

        res.status(200).json({ message: 'User logged in successfully', userProfile });
    } catch (error) {
        console.error('Error during Firebase login:', error);
        res.status(500).json({ message: 'Failed to process login.', error });
    }
});

// --- New Endpoint for Admin-only role assignment --- (No changes needed here)
router.post('/update-user-role', async (req, res) => {
    const { targetUid, newRole } = req.body;

    if (!targetUid || !['user', 'mentor', 'admin'].includes(newRole)) {
        return res.status(400).json({ message: 'Invalid user ID or role provided.' });
    }

    try {
        // First, update the role in Firestore
        const userDocRef = db.collection('users').doc(targetUid);
        await userDocRef.update({ role: newRole });
        
        // 🚨 CRITICAL: Update the custom role claim on the Firebase user object
        await admin.auth().setCustomUserClaims(targetUid, { role: newRole });

        res.status(200).json({ message: `Role for user ${targetUid} updated to ${newRole}.` });
    } catch (error) {
        console.error('Error updating user role:', error);
        res.status(500).json({ message: 'Failed to update user role.', error });
    }
});

export default router;
