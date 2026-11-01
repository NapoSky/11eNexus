import { header, footer } from './navigation.mjs';
import { renderHead } from '../lib/seo.mjs';

export function document(context, type, content) {
  return `<!doctype html>
<html lang="${context.t.lang}">
${renderHead(context, type)}
<body>${header(context, type)}${content}${footer(context)}</body>
</html>\n`;
}
