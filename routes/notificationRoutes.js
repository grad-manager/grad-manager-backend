// backend/routes/notificationRoutes.js
import express from "express";
import { admin } from "../config/firebase-config.js";
import verifyToken from "../middleware/auth.js";
import { notifyUser } from "../services/notificationService.js";

const router = express.Router();
const db = admin.firestore();

/**
 * createNotification
 * - writes to notifications collection
 * - attempts web-push to recipient's saved subscription (if any)
 */
export const createNotification = async (recipientId, senderId, message, type = "general", extras = {}) => {
  try {
    await notifyUser(recipientId, {
      senderId,
      pushTitle: extras.title || "New Notification",
      pushBody: message,
      pushUrl: extras.url || "/notifications",
      icon: extras.icon || "/logo192.png",
      type,
      relatedEntityId: extras.relatedEntityId || null,
      metadata: {
        ...extras,
        relatedEntityId: extras.relatedEntityId || null,
      },
    });
    return null;
  } catch (error) {
    console.error("[createNotification] Error creating notification:", error);
    throw error;
  }
};

// -------------------- Routes --------------------

// Route for admin to send a message to all users (works like your previous implementation)
router.post("/admin", verifyToken, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden: Only administrators can send global notifications." });
  }

  const { message } = req.body;
  if (!message) return res.status(400).json({ message: "Notification message is required." });

  try {
    const usersSnapshot = await db.collection("users").get();
    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      await notifyUser(userId, {
        senderId: req.user.uid,
        pushTitle: "Message from Admin",
        pushBody: message,
        pushUrl: "/notifications",
        icon: "/logo192.png",
        type: "admin_message",
      });
    }

    return res.status(200).json({ message: "Global notification sent successfully." });
  } catch (error) {
    console.error("Error sending global notification:", error);
    return res.status(500).json({ message: "An internal server error occurred." });
  }
});

// Route for notifying admins when a new user registers (invoked by client on signup)
router.post("/admin/new-user", verifyToken, async (req, res) => {
  try {
    const senderId = req.user.uid;
    const senderEmail = req.user.email || 'A new user';

    const adminsSnapshot = await db.collection("users").where("role", "==", "admin").get();
    const adminNotifications = adminsSnapshot.docs.map((doc) =>
      notifyUser(doc.id, {
        senderId,
        pushTitle: "New User Registration",
        pushBody: `${senderEmail} just created an account.`,
        pushUrl: "/admin",
        type: "GENERAL",
        relatedEntityId: senderId,
        metadata: { userId: senderId },
      })
    );

    await Promise.allSettled(adminNotifications);
    return res.status(200).json({ message: "Admin notifications sent." });
  } catch (error) {
    console.error("Error notifying admins about new user:", error);
    return res.status(500).json({ message: "Failed to notify admins." });
  }
});

// Route to fetch a user's notifications
router.get("/", verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const notificationsSnapshot = await db.collection("notifications")
      .where("recipientId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    const notifications = notificationsSnapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate() : null,
      };
    });

    return res.status(200).json(notifications);
  } catch (error) {
    console.error("Error fetching notifications:", error);
    return res.status(500).json({ message: "An internal server error occurred." });
  }
});

// Route to mark all notifications as read
router.put("/mark-as-read", verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const notificationsSnapshot = await db.collection("notifications")
      .where("recipientId", "==", userId)
      .where("read", "==", false)
      .get();

    const batch = db.batch();
    notificationsSnapshot.docs.forEach(doc => {
      batch.update(doc.ref, { read: true });
    });

    await batch.commit();
    return res.status(200).json({ message: "Notifications marked as read." });
  } catch (error) {
    console.error("Error marking notifications as read:", error);
    return res.status(500).json({ message: "An internal server error occurred." });
  }
});

export default router;
