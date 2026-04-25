// A one-time script to initialize fields for existing users
// Run this file once from your server environment (e.g., node migrate_user_data.js)

import { admin } from './config/firebase-config.js'; // ⬅️ ADJUST THIS PATH if needed
const db = admin.firestore();

// 💡 Updated function name to reflect both prediction and SOP migration 💡
const migrateUserLimits = async () => {
    console.log("Starting prediction and SOP limit field migration for existing users...");
    
    // Fetch all user documents
    const usersRef = db.collection('users');
    const snapshot = await usersRef.get();
    
    if (snapshot.empty) {
        console.log('No user documents found. Migration complete.');
        return;
    }
    
    let batch = db.batch();
    let batchSize = 0;
    let totalUpdated = 0;
    
    // Maximum 500 operations per Firestore batch
    const BATCH_LIMIT = 499; 

    for (const doc of snapshot.docs) {
        const userData = doc.data();
        
        // Check for missing prediction fields
        const isMissingPredictionCount = userData.predictionCount === undefined;
        const isMissingIsSubscribed = userData.isSubscribed === undefined;
        
        // 🚀 Check for missing SOP field 🚀
        const isMissingSOPLimit = userData.sopRequestsRemaining === undefined;

        if (isMissingPredictionCount || isMissingIsSubscribed || isMissingSOPLimit) {
            
            const userRef = usersRef.doc(doc.id);
            
            // Define the fields to update/set with default values
            const updates = {};
            
            // Prediction defaults
            if (isMissingPredictionCount) {
                updates.predictionCount = 0;
            }
            if (isMissingIsSubscribed) {
                updates.isSubscribed = false;
            }
            
            // 🚀 SOP Request Limit default 🚀
            if (isMissingSOPLimit) {
                // Default to 0 for Free users (no SOP access). Set -1 for unlimited when subscribing.
                updates.sopRequestsRemaining = 0;
            }

            // Add the update operation to the current batch
            // { merge: true } ensures only the specified fields are updated, preserving existing data.
            batch.set(userRef, updates, { merge: true }); 
            
            batchSize++;
            totalUpdated++;
        }

        // Commit the batch if it reaches the limit
        if (batchSize >= BATCH_LIMIT) { 
            await batch.commit();
            console.log(`Committed batch of ${batchSize} updates.`);
            
            // Start a new batch
            batch = db.batch();
            batchSize = 0;
        }
    }

    // Commit any remaining updates
    if (batchSize > 0) {
        await batch.commit();
        console.log(`Committed final batch of ${batchSize} updates.`);
    }
    
    console.log(`\n✅ Migration successful! Total users initialized/updated: ${totalUpdated}.`);
};

// Execute the migration function
// 💡 Updated function name execution 💡
migrateUserLimits().catch(error => {
    console.error("Migration failed:", error);
    process.exit(1); // Exit with error code
});
