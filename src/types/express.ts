declare global {
  namespace Express {
    interface Request {
      rider?: {
        riderId: string;
      };
      admin?: {
        adminId: string;
        email: string;
        role: 'admin';
      };
    }
  }
}

export {};
