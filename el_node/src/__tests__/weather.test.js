const request = require('supertest');

const app = require('../app');

describe('weather endpoints', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('falls back to Quanzhou when no browser location is provided', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        current: {
          temperature_2m: 26.3,
          weather_code: 1,
        },
        current_units: {
          temperature_2m: '°C',
        },
        daily: {
          temperature_2m_max: [29.1],
          temperature_2m_min: [20.2],
        },
      }),
      ok: true,
    });

    const response = await request(app).get('/api/weather/today');

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('latitude=24.8741'),
      expect.any(Object),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('longitude=118.6757'),
      expect.any(Object),
    );
    expect(response.body.data.city).toBe('泉州');
    expect(response.body.data.unit).toBe('°C');
  });

  test('uses browser latitude and longitude when location is provided', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      json: async () => ({
        current: {
          temperature_2m: 22.8,
          weather_code: 2,
        },
        current_units: {
          temperature_2m: '°C',
        },
        daily: {
          temperature_2m_max: [25.4],
          temperature_2m_min: [18.6],
        },
      }),
      ok: true,
    });

    const response = await request(app)
      .get('/api/weather/today')
      .query({ latitude: 31.2304, longitude: 121.4737 });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('latitude=31.2304'),
      expect.any(Object),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('longitude=121.4737'),
      expect.any(Object),
    );
    expect(response.body.data.city).toBe('当前位置');
    expect(response.body.data.current_temperature).toBe(22.8);
  });
});
