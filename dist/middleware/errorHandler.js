export class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err, req, res, next) {
    if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.message });
    }
    console.error('[unhandled error]', err);
    return res.status(500).json({ error: 'Internal server error' });
}
//# sourceMappingURL=errorHandler.js.map