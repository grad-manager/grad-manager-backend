// src/routes/router.js

import { Router } from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import fs from 'fs/promises';

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { admin } from '../config/firebase-config.js';
import verifyToken from '../middleware/auth.js';
import { getEffectivePlan } from '../utils/trial.js';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 

const router = Router();
const localUpload = multer({ dest: 'uploads/' });

// ⭐ UPDATED: Define feature limits based on the pricing plan image (AI Application Checker)
const PLAN_LIMITS = {
	free: 2,   // Corresponds to "2 checks"
	pro: 15,
};

// Removed: const MAX_PREDICTIONS_MVP = 7; 

const extractText = async (file) => {
    const filePath = file.path;
    const fileMimeType = file.mimetype;
    let content = '';
    try {
        const data = await fs.readFile(filePath);
        if (fileMimeType === 'application/pdf') {
            const result = await pdfParse(data);
            content = result.text;
        } else if (fileMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ buffer: data });
            content = result.value;
        } else if (fileMimeType.startsWith('text/')) {
            content = data.toString('utf8');
        } else {
            content = 'Unsupported file type.';
        }
    } catch (e) {
        console.error(`Error extracting text from ${filePath}:`, e);
        content = 'Extraction failed.';
    } finally {
        // Ensure files are deleted even if extraction fails
        try {
            await fs.unlink(filePath);
        } catch (unlinkError) {
            console.warn(`Could not delete file ${filePath}:`, unlinkError.message);
        }
    }
    console.log(`Extracted text from ${filePath}: ${content.substring(0, 100)}...`);
    return content;
};

// Helper function for file cleanup
const cleanupFiles = async (files) => {
    const filePaths = [];
    if (files?.sop?.[0]) filePaths.push(files.sop[0].path);
    if (files?.transcript?.[0]) filePaths.push(files.transcript[0].path);
    if (files?.cv?.[0]) filePaths.push(files.cv[0].path);
    
    for (const filePath of filePaths) {
        try {
            await fs.unlink(filePath);
        } catch (e) { /* ignore cleanup error */ }
    }
}


router.post('/predict', verifyToken, localUpload.fields([
    { name: 'sop', maxCount: 1 },
    { name: 'transcript', maxCount: 1 },
    { name: 'cv', maxCount: 1 }
]), async (req, res) => {
    const { user } = req;
    const { school, department } = req.body;
    const files = req.files;

    if (!files || !files.sop || !files.transcript || !files.cv) {
        await cleanupFiles(files);
        return res.status(400).json({ error: 'Missing one or more files (sop, transcript, cv)' });
    }

    try {
        // 1. **Check Prediction Limit**
        const userRef = admin.firestore().collection('users').doc(user.uid);
        const userDoc = await userRef.get();
        // Assume 'free' plan if subscription is missing or expired, and default predictionCount to 0
        const userData = userDoc.data() || {};

        // ⭐ UPDATED: Extract current plan, defaulting to 'free'
        const currentPlan = String(
            getEffectivePlan(userData, { defaultPlan: 'free', trialPlan: 'pro' })
        ).toLowerCase();
        const predictionCount = userData.predictionCount || 0;
        
        // 💡 NEW: Determine limit based on the user's plan
        const maxChecks = PLAN_LIMITS[currentPlan] || PLAN_LIMITS.free; 
        
		// Enforcement Logic
		if (predictionCount >= maxChecks) {
			await cleanupFiles(files);
			// Provide specific error message including the plan limit
			return res.status(403).json({ 
				error: `You have exceeded your plan limit of ${maxChecks} AI checks. Please upgrade to a higher plan or wait for the next renewal cycle.`,
				limitExceeded: true,
				currentPlan: currentPlan
			});
		}
        
        // --- Prediction Logic (Existing) ---
        const sopText = await extractText(files.sop[0]);
        const transcriptText = await extractText(files.transcript[0]);
        const cvText = await extractText(files.cv[0]);
        
        // Include school and department in the prompt for context
        const prompt = `You are a university admissions committee member. Your task is to analyze an applicant's materials and predict their admission score for the program: "${department}" at "${school}", on a scale of 0 to 100. Provide a JSON object with the score and a detailed reasoning for it.

Score criteria:
- 90-100: Exceptional, a top candidate for admission.
- 70-89: Very good, a competitive and well-rounded applicant.
- 50-69: Average, meets basic requirements but lacks distinction.
- 0-49: Weak, significant deficiencies or red flags.

Output format:
{ "predicted_score": number, "reasoning": string }

Applicant's documents:
SOP (Statement of Purpose): ${sopText}
CV (Curriculum Vitae): ${cvText}
Transcript (Academic Record): ${transcriptText}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const responseText = response.text();

        let predictionData;
        try {
            // Robust JSON parsing: look for JSON block markers first
            const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                predictionData = JSON.parse(jsonMatch[1]);
            } else {
                // Fallback to plain JSON parsing
                predictionData = JSON.parse(responseText.trim());
            }
        } catch (e) {
            console.error('Failed to parse JSON from Gemini:', responseText);
            predictionData = {
                predicted_score: 55,
                reasoning: "The AI model's response could not be parsed into the required JSON format. This might be due to a formatting error in the AI output. A default score of 55 has been assigned. Please try again or check the AI provider's status."
            };
        }
        
        const { predicted_score, reasoning } = predictionData;
        const predictionScore = parseFloat(predicted_score);
        
        // Log the prediction to Firestore
        await admin.firestore().collection('predictions').add({
            userId: user.uid,
            school: school || 'N/A', 
            department: department || 'N/A',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            predicted_score: predictionScore,
            reasoning: reasoning,
            sop_summary: sopText.substring(0, 100) + '...',
            transcript_summary: transcriptText.substring(0, 100) + '...',

            cv_summary: cvText.substring(0, 100) + '...'
        });

        // --- Write prediction and atomically increment the user's prediction count ---
        // Use a transaction to ensure we don't exceed the user's quota in concurrent situations.
        try {
            await admin.firestore().runTransaction(async (tx) => {
                const freshUserDoc = await tx.get(userRef);
                const freshUserData = freshUserDoc.data() || {};
                const freshPlan = String(
                    getEffectivePlan(freshUserData, { defaultPlan: 'free', trialPlan: 'pro' })
                ).toLowerCase();
                const freshCount = freshUserData.predictionCount || 0;
                const freshMax = PLAN_LIMITS[freshPlan] || PLAN_LIMITS.free;

                if (freshCount >= freshMax) {
                    // Throw a sentinel to abort the transaction and indicate limit exceeded
                    const e = new Error('LIMIT_EXCEEDED');
                    e.code = 'LIMIT_EXCEEDED';
                    throw e;
                }

                // Create a new prediction doc with a generated ID inside the transaction
                const predictionsCollection = admin.firestore().collection('predictions');
                const newPredictionRef = predictionsCollection.doc();

                tx.set(newPredictionRef, {
                    userId: user.uid,
                    school: school || 'N/A',
                    department: department || 'N/A',
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    predicted_score: predictionScore,
                    reasoning: reasoning,
                    sop_summary: sopText.substring(0, 100) + '...',
                    transcript_summary: transcriptText.substring(0, 100) + '...',
                    cv_summary: cvText.substring(0, 100) + '...'
                });

                // Increment the user's predictionCount atomically
                tx.update(userRef, {
                    predictionCount: admin.firestore.FieldValue.increment(1)
                });

            });

            // Transaction succeeded: return result
            res.json({ score: predictionScore, reasoning: reasoning });

        } catch (txErr) {
            // Handle a quota/limit exceeded case separately
            if (txErr && txErr.code === 'LIMIT_EXCEEDED') {
                await cleanupFiles(files);
                return res.status(403).json({ 
                    error: `You have exceeded your plan limit of ${maxChecks} AI checks. Please upgrade to a higher plan or wait for the next renewal cycle.`,
                    limitExceeded: true,
                    currentPlan: currentPlan
                });
            }

            console.error('Transaction error when recording prediction:', txErr);
            await cleanupFiles(files);
            return res.status(500).json({ error: 'Internal server error while saving prediction' });
        }

        // Send the result back to the frontend
        // (If the transaction succeeded we already returned above; this line ensures function flow is correct.)
        
            } catch (error) {
        console.error('Prediction endpoint error:', error);
        // Clean up any remaining files if error occurred before unlink
        await cleanupFiles(files);

        res.status(500).json({ error: 'Internal server error during prediction process' });
    }
});

export default router;
