import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

function matches(value: string | undefined, secret: string | undefined): boolean {
    return !!value && !!secret && Buffer.byteLength(value) === Buffer.byteLength(secret)
        && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
}

/** Public API authentication, plus the existing trusted service credential. */
export function apiAuth(req: Request, res: Response, next: NextFunction) {
    if (matches(req.header('x-internal-api-key'), process.env.INTERNAL_API_KEY)) return next();
    if (process.env.AUTH_MODE === 'gateway') {
        if (matches(req.header('x-gateway-trust'), process.env.GATEWAY_TRUST_SECRET)
            && req.header('x-user-id') && req.header('x-user-email') && req.header('x-user-cpf')) return next();
    } else {
        const match = /^Bearer ([^ ]+)$/i.exec(req.header('authorization') ?? '');
        try {
            if (match && process.env.JWT_SECRET) {
                jwt.verify(match[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });
                return next();
            }
        } catch { /* Invalid and expired credentials are rejected below. */ }
    }
    return res.status(401).json({ error: 'Token inválido ou não informado' });
}
