import { defineOverridesPreferences } from '@vben/preferences';

export const overridesPreferences = defineOverridesPreferences({
  app: {
    defaultHomePath: '/analytics',
    name: import.meta.env.VITE_APP_TITLE,
  },
  copyright: {
    companyName: 'goods',
    companySiteLink: '',
    date: '',
  },
});
