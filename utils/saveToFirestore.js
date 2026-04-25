import { db } from "../config/firebase-config.js";

export const saveProgramToFirestore = async (program) => {
  try {
    const docId = `${program.schoolName}-${program.programName}`
      .replace(/[^\w\s]/gi, "_")
      .replace(/\s+/g, "_");

    const docRef = db.collection("graduatePrograms").doc(docId);

    await docRef.set(
      {
        ...program,
        lastUpdated: new Date(),
      },
      { merge: true }
    );

    console.log(`✅ Saved: ${program.schoolName} - ${program.programName}`);
  } catch (err) {
    console.error("❌ Firestore save error:", err.message);
  }
};
