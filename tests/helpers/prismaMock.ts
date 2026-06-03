import { PrismaClient } from '@prisma/client';
import { mockDeep, mockReset, DeepMockProxy } from 'jest-mock-extended';

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  prisma: mockDeep<PrismaClient>(),
}));

import { prisma } from '../../src/lib/prisma';

export const prismaMock = prisma as unknown as DeepMockProxy<PrismaClient>;

export function resetPrismaMock(): void {
  mockReset(prismaMock);
}

beforeEach(() => {
  resetPrismaMock();
});
