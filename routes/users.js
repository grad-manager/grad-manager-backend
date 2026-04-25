/* routes/users.js - FULL FIXED CODE */

import express from 'express';
import { admin } from '../config/firebase-config.js';
import verifyToken from '../middleware/auth.js';
import sgMail from '@sendgrid/mail'; 
import { notifyUser } from '../services/notificationService.js';

const router = express.Router();
const db = admin.firestore();

// SendGrid Configuration
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDER_EMAIL = 'gradmanager@futuregrin.com'; 

// Set the SendGrid API key globally
if (SENDGRID_API_KEY) {
    sgMail.setApiKey(SENDGRID_API_KEY);
} else {
    console.warn("SendGrid API Key is missing. Email sending will fail."); 
}

// UPDATED HELPER FUNCTION: Sends the verification email via SendGrid with welcome text
const sendVerificationEmail = async (toEmail, verificationLink, firstName) => {
    if (!SENDGRID_API_KEY) return false; 
    
    const msg = {
        to: toEmail,
        from: `The Grad Manager Team <${SENDER_EMAIL}>`, 
        subject: 'Welcome to Grad Manager! Verify Your Email Address',
        html: `
            <p>Hello ${firstName},</p>
            <p>Welcome aboard! 🎉</p>
            <p>Thank you for signing up for **Grad Manager**. We're excited to help you manage your graduate journey.</p>
            <p>To get started and activate your account, please click the link below to verify your email address:</p>
            <p><a href="${verificationLink}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Verify My Email Address</a></p>
            <p>If you did not sign up for this account, you can safely ignore this email.</p>
            <p>Thanks,<br>The Grad Manager Team</p>
        `,
    };

    try {
        await sgMail.send(msg);
        console.log('SendGrid verification email success');
        return true;
    } catch (error) {
        console.error('SendGrid Error:', error.response ? error.response.body.errors : error.message);
        return false;
    }
}
// ------------------------------------


// Helper function to sanitize user data for public viewing
const getPublicUserData = async (doc) => { // ⬅️ FIX 1: MADE ASYNC
    if (!doc.exists) return null;

    const userData = doc.data();
    const userId = doc.id;
    let emailVerified = false;

    // 🌟 FIX 2: Fetch Auth status
    try {
        const authUser = await admin.auth().getUser(userId);
        emailVerified = authUser.emailVerified;
    } catch (e) {
        console.warn(`Auth record not found for public user: ${userId}`);
    }
    // ----------------------

    // 🛑 IMPORTANT: Only return fields safe for public viewing
    return {
        id: doc.id,
        firstName: userData.firstName,
        lastName: userData.lastName,
        photoURL: userData.photoURL || null,
        bio: userData.bio || null,
        targetCountries: userData.targetCountries || [], 
        connections: userData.connections || [], 
        emailVerified: emailVerified, // ⬅️ FIX 3: Added verification status
        // DO NOT return email, full date of birth, etc.
    };
};

// POST /api/users/signup - Handles user registration and profile creation
router.post('/signup', async (req, res) => {
    try {
        const { email, password, firstName, lastName, photoURL, gender, bio, targetCountries } = req.body;
        
        if (!email || !password || !firstName || !lastName) {
            return res.status(400).json({ message: 'Email, password, first name, and last name are required.' });
        }

        // 1. Create a user in Firebase Authentication
        const userRecord = await admin.auth().createUser({ 
            email, 
            password,
            emailVerified: false // Explicitly mark as unverified by Firebase Auth
        });
        
        // Helper to ensure targetCountries is an array or null
        const cleanedTargetCountries = 
            (Array.isArray(targetCountries) && targetCountries.length > 0) 
            ? targetCountries.filter(c => typeof c === 'string' && c.trim() !== '') 
            : [];


        const trial = {
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        };

        // 2. Create a user profile document in Firestore
        await db.collection('users').doc(userRecord.uid).set({
            email: userRecord.email,
            firstName,
            lastName,
            photoURL: photoURL || null,
            gender: gender || null,
            bio: bio || null,
            targetCountries: cleanedTargetCountries, 
            connections: [], 
            role: 'user', 
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            predictionCount: 0,
            isSubscribed: false, 
            sopRequestsRemaining: 0, 
            trial,
        });

        const adminsSnapshot = await db.collection('users').where('role', '==', 'admin').get();
        const adminNotifications = adminsSnapshot.docs.map((doc) =>
            notifyUser(doc.id, {
                senderId: userRecord.uid,
                pushTitle: 'New User Registration',
                pushBody: `${firstName} ${lastName} just created an account.`,
                emailSubject: 'New User Registration',
                emailHtml: `<p>${firstName} ${lastName} just created an account.</p>`,
                pushUrl: '/admin',
                type: 'GENERAL',
                relatedEntityId: userRecord.uid,
                metadata: { userId: userRecord.uid },
            })
        );
        await Promise.allSettled(adminNotifications);

        // 3. Generate the Firebase verification link
        const verificationLink = await admin.auth().generateEmailVerificationLink(email);

        // 4. ⭐ Use SendGrid to send the verification email ⭐
        const emailSent = await sendVerificationEmail(email, verificationLink, firstName);
        
        let successMessage = 'User created successfully. Please verify your email.';
        if (!emailSent) {
            // Handle case where SendGrid failed
            console.warn(`Failed to send verification email via SendGrid to ${email}.`);
            successMessage += ' (Warning: Email delivery failed. Check your inbox/spam or try sending verification again later.)';
        }


        res.status(201).json({ 
            message: successMessage, 
            uid: userRecord.uid 
        });
    } catch (error) {
        console.error('Error during user signup:', error);
        if (error.code === 'auth/email-already-in-use') {
            return res.status(409).json({ message: 'Email already in use.' });
        }
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

// --- NEW ROUTE: POST /api/users/resend-verification ---
// Allows an authenticated user to request a new verification email.
router.post('/resend-verification', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        
        // 1. Fetch user data from Firebase Auth to get the email and verification status
        const authUser = await admin.auth().getUser(userId);
        
        if (authUser.emailVerified) {
            return res.status(400).json({ message: 'Your email is already verified.' });
        }
        
        // 2. Fetch user profile from Firestore to get the first name for the email
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ message: 'User profile not found.' });
        }
        const { firstName } = userDoc.data();

        // 3. Generate a new Firebase verification link
        const verificationLink = await admin.auth().generateEmailVerificationLink(authUser.email);

        // 4. Use SendGrid to send the email
        const emailSent = await sendVerificationEmail(authUser.email, verificationLink, firstName);

        if (!emailSent) {
            return res.status(500).json({ message: 'Failed to send verification email. Please try again later.' });
        }

        res.status(200).json({ message: 'Verification email sent successfully. Please check your inbox and spam folder.' });

    } catch (error) {
        console.error('Error resending verification email:', error);
        // Handle Firebase error if user doesn't exist in Auth
        if (error.code === 'auth/user-not-found') {
            return res.status(404).json({ message: 'User not found in authentication system.' });
        }
        res.status(500).json({ message: 'An internal server error occurred while sending the email.' });
    }
});

// --- Remaining Routes ---

// GET /api/users/profile - Fetches the currently authenticated user's profile
router.get('/profile', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();

        if (!doc.exists) {
            return res.status(404).json({ message: 'User profile not found' });
        }

        const userData = doc.data();
        
        // ⭐ ENHANCEMENT: Provide defaults for legacy users missing prediction/SOP fields ⭐
        const profile = {
            id: doc.id,
            ...userData,
            // 💡 NEW: Include emailVerified status from Firebase Auth
            emailVerified: (await admin.auth().getUser(userId)).emailVerified,
            predictionCount: userData.predictionCount ?? 0, 
            isSubscribed: userData.isSubscribed ?? false, 
            // 💡 NEW DEFAULT FOR SOP LIMIT 💡
            sopRequestsRemaining: userData.sopRequestsRemaining ?? 0, 
            trialActive: req.user?.trialActive ?? false,
        };

        res.status(200).json(profile);
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({ message: 'Failed to fetch user profile.' });
    }
});

// 🚀 NEW ROUTE: GET /api/users/public-profile/:userId
router.get('/public-profile/:userId', verifyToken, async (req, res) => {
    try {
        const userId = req.params.userId;
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();

        const publicProfile = await getPublicUserData(doc); // ⬅️ FIX 4: ADDED AWAIT

        if (!publicProfile) {
            return res.status(404).json({ message: 'Public profile not found' });
        }

        res.status(200).json(publicProfile);
    } catch (error) {
        console.error('Error fetching public user profile:', error);
        res.status(500).json({ message: 'Failed to fetch public profile.' });
    }
});


// PUT /api/users/profile - Updates the currently authenticated user's profile
router.put('/profile', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        // 🚨 UPDATED: targetCountry -> targetCountries
        const { firstName, lastName, photoURL, bio, gender, targetCountries } = req.body;
        
        const updates = {};
        
        // Only update first/last name if a value is explicitly provided and non-empty
        if (firstName) updates.firstName = firstName;
        if (lastName) updates.lastName = lastName;

        // 🌟 FIX: For optional fields, check if they are provided (not undefined)
        if (photoURL !== undefined) updates.photoURL = photoURL || null;
        if (bio !== undefined) updates.bio = bio || null;
        if (gender !== undefined) updates.gender = gender || null;
        
        // 🚨 NEW: Handle targetCountries update as an array 🚨
        if (targetCountries !== undefined) {
            // Ensure it's an array and filter out empty strings/non-strings
            const cleanedCountries = 
                (Array.isArray(targetCountries)) 
                ? targetCountries.filter(c => typeof c === 'string' && c.trim() !== '') 
                : [];

            // Store an array, or an empty array if cleaned up to nothing
            updates.targetCountries = cleanedCountries.length > 0 ? cleanedCountries : [];
        }


        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: 'No fields provided for update.' });
        }

        const userRef = db.collection('users').doc(userId);
        await userRef.update(updates);

        res.status(200).json({ message: 'Profile updated successfully.' });
    } catch (error) {
        console.error('Error updating user profile:', error);
        res.status(500).json({ message: 'Failed to update user profile.' });
    }
});

// ⭐ NEW ROUTE: PUT /api/users/subscribe-sop
router.put('/subscribe-sop', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { isSubscribed, resetLimit } = req.body;
        
        if (typeof isSubscribed !== 'boolean') {
            return res.status(400).json({ message: 'Invalid subscription status provided.' });
        }

        const updates = {
            isSubscribed: isSubscribed,
        };

        if (isSubscribed || resetLimit) {
            // -1 indicates unlimited; unsubscribed default is 0 (no SOP access)
            updates.sopRequestsRemaining = isSubscribed ? -1 : 0; 
        }
        
        if (isSubscribed) {
            updates.predictionCount = 0;
        }


        const userRef = db.collection('users').doc(userId);
        await userRef.update(updates);

        res.status(200).json({ 
            message: `SOP subscription status updated successfully. isSubscribed: ${isSubscribed}`,
            sopRequestsRemaining: updates.sopRequestsRemaining
        });
    } catch (error) {
        console.error('Error updating SOP subscription status:', error);
        res.status(500).json({ message: 'Failed to update SOP subscription status.' });
    }
});


// ⭐ EXISTING ROUTE: PUT /api/users/subscribe (Legacy/Prediction Subscription)
router.put('/subscribe', verifyToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { isSubscribed, resetCount } = req.body;
        
        if (typeof isSubscribed !== 'boolean') {
            return res.status(400).json({ message: 'Invalid subscription status provided.' });
        }

        const updates = {
            isSubscribed: isSubscribed,
        };

        if (resetCount) {
            updates.predictionCount = 0;
        }

        const userRef = db.collection('users').doc(userId);
        await userRef.update(updates);

        res.status(200).json({ message: `Subscription status updated successfully. isSubscribed: ${isSubscribed}` });
    } catch (error) {
        console.error('Error updating subscription status:', error);
        res.status(500).json({ message: 'Failed to update subscription status.' });
    }
});


// GET /api/users - Fetches all users (often for Admin use)
router.get('/', verifyToken, async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').get();
        
        // 🌟 CRITICAL FIX 5: Fetch Auth status for all users (Admin List)
        const users = await Promise.all(usersSnapshot.docs.map(async doc => {
            const userData = doc.data();
            const userId = doc.id;
            let emailVerified = false;

            try {
                // Fetch the user record from Firebase Authentication
                const authUser = await admin.auth().getUser(userId);
                emailVerified = authUser.emailVerified;
            } catch (authError) {
                // Keep default false for zombie records
            }

            return {
                id: userId,
                ...userData,
                // Add the verified status to the admin list
                emailVerified: emailVerified, 
            };
        }));
        // ----------------------------------------------------

        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching all users:', error);
        res.status(500).json({ message: 'Failed to fetch users.' });
    }
});

// GET /api/users/:userId - Fetches a single user by ID (should be deprecated in favor of /public-profile)
router.get('/:userId', verifyToken, async (req, res) => {
    try {
        const userId = req.params.userId;
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();

        if (!doc.exists) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Note: This route will not have emailVerified unless explicitly fetched, 
        // but it's marked for deprecation, so we focus on the admin routes.
        res.status(200).json({ id: doc.id, ...doc.data() });
    } catch (error) {
        console.error('Error fetching single user:', error);
        res.status(500).json({ message: 'Failed to fetch user.' });
    }
});

// POST /api/users/get-by-ids - Fetches user profiles by a list of UIDs
router.post('/get-by-ids', verifyToken, async (req, res) => {
    const { uids } = req.body;

    if (!uids || !Array.isArray(uids) || uids.length === 0) {
        return res.status(400).json({ message: 'A non-empty array of user IDs is required.' });
    }

    try {
        // Firestore 'in' query can fetch up to 10 UIDs at once
        const usersSnapshot = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', uids).get();
        
        // 🌟 CRITICAL FIX 6: Fetch Auth status for all users
        const userPromises = usersSnapshot.docs.map(async doc => {
            const userData = doc.data();
            let emailVerified = false;
            
            try {
                const authUser = await admin.auth().getUser(doc.id);
                emailVerified = authUser.emailVerified;
            } catch (e) {
                // Ignore zombie records
            }

            return {
                uid: doc.id,
                firstName: userData.firstName,
                lastName: userData.lastName,
                emailVerified: emailVerified, // ⬅️ NEW FIELD
            };
        });

        const usersWithVerification = await Promise.all(userPromises);
        // ----------------------------------------------------

        res.status(200).json(usersWithVerification);
    } catch (error) {
        console.error('Error fetching users by IDs:', error);
        res.status(500).json({ message: 'An internal server error occurred.' });
    }
});

export default router; 
