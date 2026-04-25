import express from 'express';
// Correct way to import a CommonJS module in an ES module environment
import pkg from 'agora-token';
import verifyToken from '../middleware/auth.js';

const { RtcTokenBuilder, RtcRole } = pkg;

const router = express.Router();

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

/**
 * Converts a string UID to a 32-bit numeric UID using a hash function.
 * This is recommended by Agora for better performance.
 * @param {string} s - The string UID.
 * @returns {number} The numeric UID.
 */
function stringToNumericUid(s) {
    let hash = 0;
    if (s.length === 0) {
        return hash;
    }
    for (let i = 0; i < s.length; i++) {
        const char = s.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to a 32-bit integer
    }
    return Math.abs(hash); // Ensure the UID is a positive number
}

// POST /api/agora/token
router.post('/rtc-token', verifyToken, (req, res) => {
  try {
    const { channelName, uid } = req.body;

    if (!channelName || !uid) {
      return res.status(400).json({ message: 'channelName and uid are required.' });
    }

    // Convert the string UID to a numeric UID
    const numericUid = stringToNumericUid(uid);

    const role = RtcRole.PUBLISHER;
    const expirationTimeInSeconds = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channelName,
      numericUid, // Use the numeric UID here
      role,
      privilegeExpiredTs
    );

    // Return both the token and the numeric UID to the frontend
    res.status(200).json({ token, uid: numericUid });
  } catch (error) {
    console.error('Error generating Agora token:', error);
    res.status(500).json({ message: 'Failed to generate token.' });
  }
});

export default router;