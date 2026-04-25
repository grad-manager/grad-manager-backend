// backend/routes/communityRoutes.js

import express from 'express';
import { admin } from '../config/firebase-config.js';
import verifyToken from '../middleware/auth.js'; // Assuming you still use this
import { createNotification } from './notificationRoutes.js'; // ✅ IMPORT YOUR UTILITY

const router = express.Router();
const db = admin.firestore();

// === POST Route to submit a new comment and trigger notification ===
router.post('/posts/:postId/comments', verifyToken, async (req, res) => {
    const { postId } = req.params;
    const { content } = req.body; // Use 'content' to align with your PostTypes.ts
    const senderId = req.user.uid;
    const senderUsername = req.user.username || 'A User'; // Assume username is available via middleware

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ message: 'Comment content is required.' });
    }

    try {
        // 1. Save the new comment document (The core action)
        await db.collection('posts').doc(postId).collection('comments').add({
            userId: senderId,
            content: content,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            // You might include senderUsername and photo here for faster client display
        });

        // 2. Fetch the post to get the owner ID and title
        const postDoc = await db.collection('posts').doc(postId).get();
        if (!postDoc.exists) {
            return res.status(404).json({ message: 'Post not found.' });
        }
        
        const postData = postDoc.data();
        const postOwnerId = postData.userId;
        const postTitle = postData.title ? postData.title.substring(0, 30) : 'a community post';

        // 3. Prevent self-notification and trigger the notification
        if (postOwnerId && postOwnerId !== senderId) {
            
            // 🔥 CALL YOUR UTILITY TO CREATE IN-APP NOTIFICATION & SEND PUSH
            await createNotification(
                postOwnerId, // Recipient
                senderId, // Sender
                `${senderUsername} commented on your post: "${postTitle}..."`, // Message
                'POST_COMMENT', // Type (Matches NotificationItem.tsx)
                { 
                    relatedEntityId: postId, // Link for the in-app list
                    url: `/community/${postId}` // Deep link for the push notification
                }
            );
        }

        // 4. Update the post's aggregated comment count (Optional but recommended)
        await db.collection('posts').doc(postId).update({
             commentsCount: FieldValue.increment(1)
        });

        return res.status(201).json({ message: "Comment created successfully." });

    } catch (error) {
        console.error('Error processing comment submission:', error);
        return res.status(500).json({ message: 'Failed to submit comment.' });
    }
});

// === (Add other community routes here, like liking/unliking if not done via the client SDK) ===

export default router;