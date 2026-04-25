// setAdminRole.js

import 'dotenv/config';
import admin from 'firebase-admin';

// Initialize Firebase Admin SDK using environment variables
try {
  const firebaseServiceAccountString = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (!firebaseServiceAccountString) {
    throw new Error('FIREBASE_ADMIN_SERVICE_ACCOUNT is not set in environment variables');
  }

  // Parse the JSON string and replace escaped newline characters
  const serviceAccount = JSON.parse(firebaseServiceAccountString);
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin SDK initialized successfully for script.');
  }
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin SDK:', error);
  process.exit(1);
}

// Get a Firestore instance
const db = admin.firestore();

// --- Configuration ---
// The email of the user you want to make an admin
const userEmail = 'aayomide655@gmail.com'; 
const newRole = 'admin';

const setCustomRole = async () => {
  try {
    // 1. Find the user in Firebase Authentication
    const user = await admin.auth().getUserByEmail(userEmail);

    // 2. Set the custom claim on the Firebase Auth user
    await admin.auth().setCustomUserClaims(user.uid, { role: newRole });
    console.log(`✅ Successfully set custom claim 'role: ${newRole}' for user: ${userEmail}`);

    // 3. Update the 'role' field in the Firestore document
    const userDocRef = db.collection('users').doc(user.uid);
    await userDocRef.update({ role: newRole });
    console.log(`✅ Successfully updated Firestore document with 'role: ${newRole}' for user: ${userEmail}`);
    
    // Optional: Log the final user data to verify
    const updatedUserDoc = await userDocRef.get();
    console.log('Updated Firestore user data:', updatedUserDoc.data());

    console.log(`\n🎉 User ${userEmail} now has the ${newRole} role in both Firebase Auth and Firestore.`);
  } catch (error) {
    console.error('❌ Error setting custom claim or updating Firestore:', error);
  } finally {
    // Exit the script once complete
    process.exit(0);
  }
};

setCustomRole();