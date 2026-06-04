// Mock the `uuid` package globally because v14 ships pure ESM that the
// default Jest CJS runtime can't load. The actual ID values don't matter
// for any of our route tests — handlers just need a string back.
jest.mock('uuid', () => {
  let counter = 0;
  return {
    v4: jest.fn(() => {
      counter += 1;
      const seq = counter.toString(16).padStart(8, '0');
      return `${seq}-0000-0000-0000-000000000000`;
    }),
  };
});
