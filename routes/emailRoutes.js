// src/routes/emailRoutes.js

import express from 'express';
import { sendWelcomeEmail } from '../services/sendGridService.js';
// Note: We are explicitly NOT using the `verifyToken` middleware for this specific route
// because the user is not yet logged in/verified when the signup process calls it.

const router = express.Router();

// POST /api/emails/send-welcome
// This endpoint is called immediately after a successful signup via email/password.
router.post('/send-welcome', async (req, res) => {
    const { email, firstName } = req.body;

    if (!email || !firstName) {
        return res.status(400).json({ message: 'Missing email or first name for welcome email.' });
    }

    try {
        await sendWelcomeEmail(email, firstName);
        res.status(200).json({ message: 'Welcome email successfully triggered.' });
    } catch (error) {
        // Log error but send a success response to the client if auth was successful.
        // The failure of a non-critical email should not stop the user flow.
        console.error("API call to send welcome email failed:", error.message);
        // Send a 202 (Accepted) or 200, as the signup itself succeeded.
        res.status(200).json({ message: 'Signup successful, but welcome email failed to send in the background.' });
    }
});

// IMPORTANT: Keep existing email routes here, likely protected by verifyToken
// Example:
// router.post('/send-feedback', verifyToken, async (req, res) => { ... });

export default router;