// routes/welcomeEmailRoutes.js

import express from 'express';
// Assuming your sendGridService.js is imported like this:
import { sendWelcomeEmail } from '../services/sendGridService.js'; 

const router = express.Router();

// POST /api/welcome/send-welcome
// This route is explicitly UNPROTECTED by verifyToken
router.post('/send-welcome', async (req, res) => {
    const { email, firstName } = req.body;

    if (!email || !firstName) {
        return res.status(400).json({ message: 'Missing email or first name for welcome email.' });
    }

    try {
        await sendWelcomeEmail(email, firstName);
        res.status(200).json({ message: 'Welcome email successfully triggered.' });
    } catch (error) {
        console.error("API call to send welcome email failed:", error.message);
        // Send a 200/202 so the signup flow isn't blocked by an email failure
        res.status(202).json({ message: 'Signup successful, but welcome email failed to send in the background.' });
    }
});

export default router;