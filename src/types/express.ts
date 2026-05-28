import { AdminTokenPayload } from '../middleware/admin-auth';
import { RiderTokenPayload } from '../middleware/rider-auth';

declare global {
  namespace Express {
    interface Request {
      rider?: RiderTokenPayload;
      admin?: AdminTokenPayload;
    }
  }
}

export {};
