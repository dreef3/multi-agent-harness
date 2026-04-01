// Augment Express Request to carry the raw request body buffer.
// Populated by the express.json({ verify }) hook in index.ts.
declare namespace Express {
  interface Request {
    rawBody?: Buffer;
    user?: import("../api/auth.js").AuthUser;
  }
}
