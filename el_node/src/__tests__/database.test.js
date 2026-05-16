const { shouldSeedDemoData } = require('../config/database');

const withEnv = (env, callback) => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSeedDemoData = process.env.SEED_DEMO_DATA;

  process.env.NODE_ENV = env.NODE_ENV;
  if (Object.hasOwn(env, 'SEED_DEMO_DATA')) {
    process.env.SEED_DEMO_DATA = env.SEED_DEMO_DATA;
  } else {
    delete process.env.SEED_DEMO_DATA;
  }

  try {
    callback();
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousSeedDemoData === undefined) {
      delete process.env.SEED_DEMO_DATA;
    } else {
      process.env.SEED_DEMO_DATA = previousSeedDemoData;
    }
  }
};

describe('database seed guards', () => {
  test('does not seed demo data by default', () => {
    withEnv({ NODE_ENV: 'development' }, () => {
      expect(shouldSeedDemoData()).toBe(false);
    });

    withEnv({ NODE_ENV: 'test' }, () => {
      expect(shouldSeedDemoData()).toBe(false);
    });
  });

  test('does not seed demo data in production unless explicitly enabled', () => {
    withEnv({ NODE_ENV: 'production' }, () => {
      expect(shouldSeedDemoData()).toBe(false);
    });

    withEnv({ NODE_ENV: 'production', SEED_DEMO_DATA: 'true' }, () => {
      expect(shouldSeedDemoData()).toBe(true);
    });
  });

  test('allows explicitly disabling demo data in development', () => {
    withEnv({ NODE_ENV: 'development', SEED_DEMO_DATA: 'false' }, () => {
      expect(shouldSeedDemoData()).toBe(false);
    });
  });
});
