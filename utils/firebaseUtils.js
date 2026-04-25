import { db } from "../config/firebase-config.js";

/**
 * Save a single program to Firestore (or Realtime DB)
 * @param {string} collectionName - The Firestore collection name
 * @param {Array|Object} data - Array of programs or single program object
 */
export async function saveProgramsToFirebase(collectionName, data) {
  try {
    const isArray = Array.isArray(data);
    const items = isArray ? data : [data];

    for (const program of items) {
      const docId = `${program.title || program.programName || "unknown"}`
        .replace(/[^\w\s]/gi, "_")
        .replace(/\s+/g, "_");

      const docRef = db.collection(collectionName).doc(docId);
      await docRef.set(
        {
          ...program,
          lastUpdated: new Date(),
        },
        { merge: true }
      );
    }

    console.log(`✅ Saved ${items.length} record(s) to ${collectionName}`);
  } catch (err) {
    console.error("❌ Firestore save error:", err.message);
  }
}
