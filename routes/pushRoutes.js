import express from "express";
import { admin } from "../config/firebase-config.js";
import verifyToken from "../middleware/auth.js"; // Assume this is used where appropriate
import { notifyUser } from "../services/notificationService.js";

const router = express.Router();
const db = admin.firestore();

/**
 * === Save user push subscription ===
 * Each user can only have one active subscription document.
 */
router.post("/subscribe", verifyToken, async (req, res) => {
  try {
    const subscription = req.body;
    const userId = req.user?.uid;

    if (!subscription || !userId) {
      return res.status(400).json({ error: "Missing subscription or user ID" });
    }

    // Stores subscription directly under the user's ID
    await db.collection("subscriptions").doc(userId).set(subscription);

    return res.status(201).json({ message: "Subscription saved successfully ✅" });
  } catch (error) {
    console.error("[/subscribe] Error saving subscription:", error);
    return res.status(500).json({ error: "Failed to save subscription" });
  }
});

/**
 * === POST /broadcast: Send a push notification to ALL subscribed users ===
 * Triggered when a new community post is created.
 */
router.post("/broadcast", verifyToken, async (req, res) => {
    const { title, body, data } = req.body; 
    const senderId = req.user?.uid;

    if (!title || !body || !senderId) {
        return res.status(400).json({ error: "Missing notification title, body, or sender ID." });
    }

    try {
        // 1. Fetch ALL subscriptions from the database
        const usersSnapshot = await db.collection("users").get();
        const sendPromises = usersSnapshot.docs.map(async (doc) => {
            const userId = doc.id;
            if (userId === senderId) return;
            await notifyUser(userId, {
                senderId,
                pushTitle: title,
                pushBody: body,
                pushUrl: data?.url || '/feed',
                type: 'NEW_FEED_ITEM',
                relatedEntityId: data?.postId || null,
                metadata: data || null,
            });
        });
        await Promise.allSettled(sendPromises);

        res.status(200).json({ success: true, message: 'Broadcast processed.' });

    } catch (error) {
        console.error("[/broadcast] Server error:", error);
        res.status(500).json({ error: "Internal server error during broadcast." });
    }
});

/**
 * === POST /notify: Dedicated route for new chat messages ===
 * This endpoint is called directly by the client's ChatPage.tsx 
 * to notify the recipient of a new message.
 */
router.post("/notify", verifyToken, async (req, res) => {
  // Data sent from the frontend ChatPage.tsx
  const { targetUserId, title, body, data } = req.body;
  const senderId = req.user?.uid; // Sender is the authenticated user

  if (!targetUserId || !title || !body || !senderId) {
    return res.status(400).json({ error: "Missing required fields (targetUserId, title, body, or senderId)" });
  }

  try {
    await notifyUser(targetUserId, {
      senderId,
      pushTitle: title,
      pushBody: body,
      pushUrl: data?.url || `/chat/${senderId}`,
      type: 'CHAT_MESSAGE',
      relatedEntityId: data?.chatId || null,
      metadata: data || null,
    });

    return res.status(200).json({ success: true, message: 'Notification sent successfully 🎉' });
  } catch (error) {
    console.error("[/notify] Server error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
});


/**
 * === Send a push notification to a specific user (Admin/Generic Test) ===
 * Useful for admin actions or testing notifications manually.
 */
router.post("/send", async (req, res) => {
  // ... (Your existing /send logic remains here)
  try {
    const { userId, title, body } = req.body;
    if (!userId || !title || !body)
      return res.status(400).json({ error: "Missing required fields (userId, title, body)" });
    await notifyUser(userId, {
      pushTitle: title,
      pushBody: body,
      pushUrl: '/notifications',
      type: 'GENERAL',
    });
    return res.status(200).json({ message: "Notification sent 🎉" });
  } catch (error) {
    console.error("[/send] Error sending notification:", error);
    return res.status(500).json({ error: "Failed to send notification" });
  }
});


export default router;
