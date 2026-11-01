import { hero } from '../sections/hero.mjs';
import { statistics } from '../sections/statistics.mjs';
import { community } from '../sections/community.mjs';
import { featured } from '../sections/featured.mjs';
import { catalogue } from '../sections/catalogue.mjs';
import { origins } from '../sections/origins.mjs';
import { faq } from '../sections/faq.mjs';
import { join } from '../sections/join.mjs';

const sections = [hero, statistics, community, featured, catalogue, origins, faq, join];

export function landing(context) {
  return `<main id="main">${sections.map((render) => render(context)).join('\n')}</main>`;
}
