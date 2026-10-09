// Issuer authentication: bcrypt-checked login that returns a short-lived JWT, and middleware to require it.
// One admin account comes from the environment (ADMIN_USERNAME, ADMIN_PASSWORD_HASH). Nothing secret is hardcoded.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const MIN_SECRET_LENGTH = 32;
const ALGORITHM = 'HS256';
const ISSUER = 'mindforge';

function validateAuthConfig(cfg) {
    const problems = [];
    if (!cfg || typeof cfg.jwtSecret !== 'string' || cfg.jwtSecret.length < MIN_SECRET_LENGTH) {
        problems.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    }
    if (!cfg || !cfg.adminUsername) problems.push('ADMIN_USERNAME is required');
    if (!cfg || !/^\$2[aby]\$\d\d\$.{53}$/.test(cfg.adminPasswordHash || '')) {
        problems.push('ADMIN_PASSWORD_HASH must be a bcrypt hash (generate one with: npm run hash-password)');
    }
    if (problems.length) throw new Error('Invalid auth configuration: ' + problems.join('; '));
}

function createAuth(cfg) {
    validateAuthConfig(cfg);
    const { jwtSecret, adminUsername, adminPasswordHash, tokenTtl = '8h' } = cfg;
    // Compared against when the username is wrong, so a wrong username costs the same time as a wrong password.
    const decoyHash = bcrypt.hashSync('decoy', 10);

    // Returns a signed token, or null for any bad credentials (callers must not say which part was wrong).
    async function login(username, password) {
        const userOk = typeof username === 'string' && username === adminUsername;
        const passOk = await bcrypt.compare(typeof password === 'string' ? password : '', userOk ? adminPasswordHash : decoyHash);
        if (!(userOk && passOk)) return null;
        return jwt.sign({ sub: adminUsername, role: 'issuer' }, jwtSecret, { algorithm: ALGORITHM, issuer: ISSUER, expiresIn: tokenTtl });
    }

    function requireAuth(req, res, next) {
        const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        if (!match) return res.status(401).json({ success: false, error: 'Authentication required.' });
        try {
            // Pinning the algorithm blocks "alg: none" and key-confusion tricks.
            req.user = jwt.verify(match[1], jwtSecret, { algorithms: [ALGORITHM], issuer: ISSUER });
            next();
        } catch {
            res.status(401).json({ success: false, error: 'Invalid or expired token.' });
        }
    }

    /**
     * Like requireAuth, but a request with no valid token carries on as an anonymous member of the public. Used where issuers get
     * more detail than the public (for example, verification shows an issuer the document's true field values).
     */
    function optionalAuth(req, res, next) {
        const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        if (match) {
            try { req.user = jwt.verify(match[1], jwtSecret, { algorithms: [ALGORITHM], issuer: ISSUER }); } catch { /* treated as the public */ }
        }
        next();
    }

    return { login, requireAuth, optionalAuth };
}

module.exports = { createAuth, validateAuthConfig, MIN_SECRET_LENGTH };
