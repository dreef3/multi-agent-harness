import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Request, Response, NextFunction } from "express";

export function validateBody<T extends TSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!Value.Check(schema, req.body)) {
      const errors = [...Value.Errors(schema, req.body)].map(e => ({
        path: e.path,
        message: e.message,
      }));
      res.status(400).json({ error: "Validation failed", details: errors });
      return;
    }
    next();
  };
}
