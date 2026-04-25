// middleware/checkRole.js

const checkRole = (requiredRole) => {
    return (req, res, next) => {
        // req.user is populated by verifyToken middleware
        if (!req.user || !req.user.role || req.user.role !== requiredRole) {
            return res.status(403).json({ message: 'Access denied. Insufficient privileges.' });
        }
        next();
    };
};

export default checkRole;