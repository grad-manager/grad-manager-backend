// backend/routes/chatRoutes.js

import express from 'express';
import { admin } from '../config/firebase-config.js';
import { FieldValue } from 'firebase-admin/firestore';
import verifyToken from '../middleware/auth.js'; // 🔥 REQUIRED: Import auth middleware
import { createNotification } from './notificationRoutes.js'; // 🔥 REQUIRED: Import utility

const router = express.Router();
const db = admin.firestore();

// === POST Route to send a new message and trigger CHAT_MESSAGE notification ===
router.post('/:chatId/messages', verifyToken, async (req, res) => {
    const { chatId } = req.params;
    const { content } = req.body;
    const senderId = req.user.uid;
    // NOTE: Ensure req.user.username is populated in your verifyToken middleware
    const senderUsername = req.user.username || 'A User'; 

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ message: 'Message content is required.' });
    }

    try {
        // 1. Save the message (Core Action)
        const messageRef = await db.collection('chats').doc(chatId).collection('messages').add({
            senderId: senderId,
            content: content,
            createdAt: FieldValue.serverTimestamp(),
        });

        // 2. Fetch the chat document to get participants
        const chatDoc = await db.collection('chats').doc(chatId).get();
        const participants = chatDoc.data()?.members || []; 

        // 3. Identify recipient(s) and trigger notification(s)
        const recipients = participants.filter(id => id !== senderId);

        for (const recipientId of recipients) {
            
            // 🔥 CALL YOUR UTILITY TO CREATE IN-APP NOTIFICATION & SEND PUSH
            await createNotification(
                recipientId, // Recipient
                senderId, // Sender
                `${senderUsername} sent a message: "${content.substring(0, 50)}..."`, // Message preview
                'CHAT_MESSAGE', // Type
                { 
                    relatedEntityId: chatId, 
                    url: `/chat/${chatId}` // Deep link for the push notification
                }
            );
        }

        // 4. Update the chat document with the latest message info 
        await db.collection('chats').doc(chatId).update({
            lastMessage: content.substring(0, 100), 
            updatedAt: FieldValue.serverTimestamp(),
        });

        return res.status(201).json({ 
            message: 'Message sent and notification(s) dispatched.', 
            id: messageRef.id 
        });

    } catch (error) {
        console.error('Error sending message and notification:', error);
        return res.status(500).json({ message: 'Failed to send message.' });
    }
});


// === GET Route to fetch chat details and recipient info ===
router.get('/details/:chatId', verifyToken, async (req, res) => { // ✅ Added verifyToken
    try {
        const { chatId } = req.params;
        const [user1Id, user2Id] = chatId.split('_');

        // We assume `req.user` is available from a `verifyToken` middleware
        const recipientId = req.user.uid === user1Id ? user2Id : user1Id;

        const recipientDoc = await db.collection('users').doc(recipientId).get();
        const recipient = recipientDoc.exists ? { id: recipientDoc.id, ...recipientDoc.data() } : null;

        res.status(200).json({ recipient });
    } catch (error) {
        console.error('Error fetching chat details:', error);
        res.status(500).json({ message: 'Failed to fetch chat details.' });
    }
});

// === PUT Route to mark a chat as read ===
router.put('/read/:chatId', verifyToken, async (req, res) => { // ✅ Added verifyToken
    try {
        const { chatId } = req.params;
        const currentUserId = req.user.uid;

        await db.collection('chats').doc(chatId).update({
            [`lastRead.${currentUserId}`]: FieldValue.serverTimestamp()
        });

        res.status(200).json({ message: 'Chat marked as read successfully.' });
    } catch (error) {
        console.error('Error marking chat as read:', error);
        res.status(500).json({ message: 'Failed to mark chat as read.' });
    }
});

// === GET Route to fetch unread chat counts ===
router.get('/unread-counts', verifyToken, async (req, res) => { // ✅ Added verifyToken
    const userId = req.user.uid; 

    try {
        const chatsSnapshot = await db.collection('chats')
            .where('members', 'array-contains', userId)
            .get();

        const unreadCounts = [];

        for (const chatDoc of chatsSnapshot.docs) {
            const chatData = chatDoc.data();
            const lastReadTimestamp = chatData.lastRead?.[userId];
            
            let unreadCount = 0;
            if (lastReadTimestamp) {
                // Get messages created AFTER the user's lastRead timestamp
                const messagesSnapshot = await chatDoc.ref.collection('messages')
                    .where('createdAt', '>', lastReadTimestamp)
                    .get();
                unreadCount = messagesSnapshot.size;
            } else {
                // If lastRead is not set, all messages are unread
                const messagesSnapshot = await chatDoc.ref.collection('messages').get();
                unreadCount = messagesSnapshot.size;
            }

            unreadCounts.push({
                chatId: chatDoc.id,
                unreadCount: unreadCount
            });
        }

        res.status(200).json(unreadCounts);
    } catch (error) {
        console.error('Failed to get unread counts:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

export default router;