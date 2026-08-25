import jwt from 'jsonwebtoken';
import { env } from '../env.js';
export function signAuthToken(payload) {
    return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
}
/** Requires a valid Bearer JWT; attaches req.user. */
export function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }
    const token = header.slice('Bearer '.length);
    try {
        req.user = jwt.verify(token, env.JWT_SECRET);
        next();
    }
    catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}
/** Requires req.user.role to be one of `roles`. Must run after requireAuth. */
export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient role for this action' });
        }
        next();
    };
}
//# sourceMappingURL=auth.js.map