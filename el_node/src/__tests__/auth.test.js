const request = require('supertest');

const app = require('../app');
const { closePool, initializeDatabase } = require('../config/database');

beforeAll(async () => {
  await initializeDatabase();
});

afterAll(async () => {
  await closePool();
});

describe('auth endpoints', () => {
  test('registers a new user with the default user role', async () => {
    const username = `tester_${Date.now()}`;
    const response = await request(app).post('/api/auth/register').send({
      password: 'test123456',
      username,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      code: 0,
      data: {
        id: expect.any(Number),
        username,
      },
      message: 'ok',
    });

    const loginResponse = await request(app).post('/api/auth/login').send({
      password: 'test123456',
      username,
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.data.accessToken).toEqual(expect.stringMatching(/^dev-token-/));

    const headers = {
      Authorization: `Bearer ${loginResponse.body.data.accessToken}`,
    };
    const userInfoResponse = await request(app).get('/api/user/info').set(headers);
    const codesResponse = await request(app).get('/api/auth/codes').set(headers);

    expect(userInfoResponse.body.data.roles).toEqual(['user']);
    expect(userInfoResponse.body.data.homePath).toBe('/analytics');
    expect(codesResponse.body.data).toEqual(['AC_DASHBOARD_WORKSPACE']);
  });

  test('rejects duplicate usernames during registration', async () => {
    const response = await request(app).post('/api/auth/register').send({
      password: 'admin123',
      username: 'admin',
    });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('Username already exists');
  });

  test('requires username and password during registration', async () => {
    const response = await request(app).post('/api/auth/register').send({});

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Username and password are required');
  });

  test('requires username and password', async () => {
    const response = await request(app).post('/api/auth/login').send({});

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Username and password are required');
  });

  test('rejects invalid credentials', async () => {
    const response = await request(app).post('/api/auth/login').send({
      username: 'admin',
      password: 'wrong-password',
    });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid username or password');
  });

  test('logs in with the seeded admin account using the Vben response shape', async () => {
    const response = await request(app).post('/api/auth/login').send({
      username: 'admin',
      password: 'admin123',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      code: 0,
      data: {
        accessToken: expect.stringMatching(/^dev-token-/),
      },
      message: 'ok',
    });
  });

  test('returns access codes for the logged-in app flow', async () => {
    const response = await request(app).get('/api/auth/codes');

    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    expect(response.body.data).toContain('AC_100100');
    expect(response.body.data).toContain('AC_DASHBOARD_WORKSPACE');
    expect(response.body.data).toContain('AC_SYSTEM_ADMIN');
  });

  test('refreshes the development token', async () => {
    const response = await request(app).post('/api/auth/refresh');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      code: 0,
      data: 'dev-token-1',
      message: 'ok',
    });
  });

  test('logs out successfully', async () => {
    const response = await request(app).post('/api/auth/logout');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      code: 0,
      data: null,
      message: 'ok',
    });
  });
});

describe('user endpoints', () => {
  test('returns user info for the logged-in app flow', async () => {
    const response = await request(app).get('/api/user/info');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      code: 0,
      data: {
        homePath: '/analytics',
        realName: 'Admin',
        roles: ['super', 'admin'],
        username: 'admin',
      },
    });
  });
});

describe('menu endpoints', () => {
  test('returns role-filtered menus for the logged-in app flow', async () => {
    const response = await request(app).get('/api/menu/all');

    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    expect(response.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Analytics', path: '/analytics' }),
        expect.objectContaining({
          name: 'Workspace',
          meta: expect.objectContaining({ hideInMenu: true }),
        }),
        expect.objectContaining({ name: 'Demos' }),
      ]),
    );
  });
});
