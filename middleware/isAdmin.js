// src/middleware/isAdmin.js
const isAdmin = (req, res, next) => {
    // This check assumes `req.user` is populated by a preceding middleware
    // like the `verifyToken` middleware.
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }
};

export default isAdmin;