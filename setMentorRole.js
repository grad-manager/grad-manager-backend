import 'dotenv/config';
import admin from 'firebase-admin';

// Initialize Firebase Admin SDK using environment variables
try {
  const firebaseServiceAccountString = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
  if (!firebaseServiceAccountString) {
    throw new Error('FIREBASE_ADMIN_SERVICE_ACCOUNT is not set in environment variables');
  }

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

const db = admin.firestore();

// --- Configuration ---
const userEmail = 'test@gmail.com';
const newRole = 'mentor';

const setCustomRole = async () => {
  try {
    const user = await admin.auth().getUserByEmail(userEmail);
    await admin.auth().setCustomUserClaims(user.uid, { role: newRole });
    console.log(`✅ Successfully set custom claim 'role: ${newRole}' for user: ${userEmail}`);

    const userDocRef = db.collection('users').doc(user.uid);
    // Use an update operation to ensure the document exists and is not overwritten
    await userDocRef.update({ 
      role: newRole,
      isAvailable: true // <-- ADD THIS LINE
    });
    console.log(`✅ Successfully updated Firestore document with 'role: ${newRole}' and 'isAvailable: true' for user: ${userEmail}`);
    
    const updatedUserDoc = await userDocRef.get();
    console.log('Updated Firestore user data:', updatedUserDoc.data());

    console.log(`\n🎉 User ${userEmail} now has the ${newRole} role in both Firebase Auth and Firestore.`);
  } catch (error) {
    console.error('❌ Error setting custom claim or updating Firestore:', error);
  } finally {
    process.exit(0);
  }
};

setCustomRole();