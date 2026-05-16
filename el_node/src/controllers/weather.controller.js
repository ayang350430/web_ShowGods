const weatherService = require('../services/weather.service');

const getTodayWeather = async (req, res, next) => {
  try {
    const weather = await weatherService.getTodayWeather({
      latitude: req.query.latitude,
      longitude: req.query.longitude,
    });

    return res.json({
      code: 0,
      data: weather,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getTodayWeather,
};
