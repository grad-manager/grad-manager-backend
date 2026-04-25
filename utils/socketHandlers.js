export const registerSocketHandlers = (io) => {
    io.on('connection', (socket) => {
        console.log('A user connected:', socket.id);

        // Handle joining a group chat
        socket.on('join_group_chat', (groupId) => {
            socket.join(groupId);
            console.log(`User ${socket.id} joined group ${groupId}`);
        });

        // Handle sending a message
        socket.on('send_message', (messageData) => {
            const { groupId } = messageData;
            if (groupId) {
                // Emit the message to all clients in the specified group
                io.to(groupId).emit('receive_message', messageData);
            }
        });

        // Handle disconnection
        socket.on('disconnect', () => {
            console.log('A user disconnected:', socket.id);
        });
    });
};