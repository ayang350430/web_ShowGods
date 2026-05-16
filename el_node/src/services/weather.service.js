const FALLBACK_LOCATION = {
  latitude: 24.8741,
  longitude: 118.6757,
  name: '泉州',
};

const WEATHER_CACHE_TTL = 10 * 60 * 1000;
const WEATHER_FETCH_TIMEOUT = 1500;
const weatherCache = new Map();

const toCoordinate = (value) => {
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? coordinate : null;
};

const getLocation = ({ latitude, longitude } = {}) => {
  const parsedLatitude = toCoordinate(latitude);
  const parsedLongitude = toCoordinate(longitude);

  if (parsedLatitude !== null && parsedLongitude !== null) {
    return {
      latitude: parsedLatitude,
      longitude: parsedLongitude,
      name: '当前位置',
    };
  }

  return FALLBACK_LOCATION;
};

const cacheKeyOf = (location) =>
  `${Number(location.latitude).toFixed(3)},${Number(location.longitude).toFixed(3)}`;

const getTodayWeather = async (options = {}) => {
  const location = getLocation(options);
  const cacheKey = cacheKeyOf(location);
  const cached = weatherCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.cachedAt < WEATHER_CACHE_TTL) {
    return cached.data;
  }

  const params = new URLSearchParams({
    current: 'temperature_2m,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min',
    forecast_days: '1',
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    timezone: 'Asia/Shanghai',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_FETCH_TIMEOUT);
  let response;

  try {
    response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: controller.signal,
    });
  } catch (error) {
    if (cached) {
      return cached.data;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    if (cached) {
      return cached.data;
    }
    const error = new Error('Failed to fetch weather');
    error.statusCode = 502;
    throw error;
  }

  const data = await response.json();
  const weather = {
    city: location.name,
    current_temperature: Number(data.current?.temperature_2m ?? 0),
    temperature_max: Number(data.daily?.temperature_2m_max?.[0] ?? 0),
    temperature_min: Number(data.daily?.temperature_2m_min?.[0] ?? 0),
    unit: data.current_units?.temperature_2m || '°C',
    weather_code: Number(data.current?.weather_code ?? 0),
  };

  weatherCache.set(cacheKey, {
    cachedAt: Date.now(),
    data: weather,
  });

  return weather;
};

module.exports = {
  getTodayWeather,
};
