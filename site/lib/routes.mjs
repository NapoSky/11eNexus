export const languages = ['fr', 'en'];
export const pageTypes = ['home', 'terms', 'privacy', 'credits'];

export function pagePath(language, type = 'home') {
  if (!languages.includes(language) || !pageTypes.includes(type))
    throw new Error('Unknown site route');
  const prefix = language === 'fr' ? '/' : '/en/';
  return type === 'home' ? prefix : `${prefix}nexus/${type}/`;
}

export const siteRoutes = () =>
  languages.flatMap((language) =>
    pageTypes.map((type) => ({ language, type, path: pagePath(language, type) })),
  );

export function languageLinks(origin, type) {
  return [
    ...languages.map((language) => ({ language, url: `${origin}${pagePath(language, type)}` })),
    { language: 'x-default', url: `${origin}${pagePath('fr', type)}` },
  ];
}
