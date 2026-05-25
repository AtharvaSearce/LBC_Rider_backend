declare global {
  namespace Express {
    interface Request {
      rider?: {
        riderId: string;
      };
    }
  }
}

export {};
