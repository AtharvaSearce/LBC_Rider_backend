import type { AdminTokenPayload } from '../middleware/admin-auth';
import type { RiderTokenPayload } from '../middleware/rider-auth';

declare global {
  namespace Express {
    interface Request {
      rider?: RiderTokenPayload;
      admin?: AdminTokenPayload;
    }
  }
}

export type { AdminTokenPayload, RiderTokenPayload };
