// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import {
  ThemeProvider,
  createQueryClient,
  getRouterBasepath,
  I18nProvider,
  type Catalogs,
} from '@mochi/web'
// Generated Routes
import { routeTree } from './routeTree.gen'
// Styles
import './styles/index.css'

// Lingui catalogs bundled by @lingui/vite-plugin (compiled from
// src/locales/<lang>/messages.po on the fly).
const catalogs: Catalogs = {
  en: () => import('./locales/en/messages.po'),
  'en-us': () => import('./locales/en-us/messages.po'),
  fr: () => import('./locales/fr/messages.po'),
  ja: () => import('./locales/ja/messages.po'),
  jv: () => import('./locales/jv/messages.po'),
  sd: () => import('./locales/sd/messages.po'),
  bho: () => import('./locales/bho/messages.po'),
  su: () => import('./locales/su/messages.po'),
  om: () => import('./locales/om/messages.po'),
  yue: () => import('./locales/yue/messages.po'),
  'fr-ca': () => import('./locales/fr-ca/messages.po'),
  'zh-hk': () => import('./locales/zh-hk/messages.po'),
  'de-ch': () => import('./locales/de-ch/messages.po'),
  nn: () => import('./locales/nn/messages.po'),
  'en-ca': () => import('./locales/en-ca/messages.po'),
  'es-ar': () => import('./locales/es-ar/messages.po'),
  my: () => import('./locales/my/messages.po'),
  ps: () => import('./locales/ps/messages.po'),
  kk: () => import('./locales/kk/messages.po'),
  uz: () => import('./locales/uz/messages.po'),
  az: () => import('./locales/az/messages.po'),
  km: () => import('./locales/km/messages.po'),
  lo: () => import('./locales/lo/messages.po'),
  mn: () => import('./locales/mn/messages.po'),
  cy: () => import('./locales/cy/messages.po'),
  ga: () => import('./locales/ga/messages.po'),
  gd: () => import('./locales/gd/messages.po'),
  mt: () => import('./locales/mt/messages.po'),
  eu: () => import('./locales/eu/messages.po'),
  gl: () => import('./locales/gl/messages.po'),
  tg: () => import('./locales/tg/messages.po'),
  ky: () => import('./locales/ky/messages.po'),
  tk: () => import('./locales/tk/messages.po'),
  qu: () => import('./locales/qu/messages.po'),
  ay: () => import('./locales/ay/messages.po'),
  gn: () => import('./locales/gn/messages.po'),
  ht: () => import('./locales/ht/messages.po'),
  hy: () => import('./locales/hy/messages.po'),
  ckb: () => import('./locales/ckb/messages.po'),
  ku: () => import('./locales/ku/messages.po'),
  ka: () => import('./locales/ka/messages.po'),
  tr: () => import('./locales/tr/messages.po'),
  fa: () => import('./locales/fa/messages.po'),
  ro: () => import('./locales/ro/messages.po'),
  bg: () => import('./locales/bg/messages.po'),
  hr: () => import('./locales/hr/messages.po'),
  sr: () => import('./locales/sr/messages.po'),
  sk: () => import('./locales/sk/messages.po'),
  sl: () => import('./locales/sl/messages.po'),
  ca: () => import('./locales/ca/messages.po'),
  et: () => import('./locales/et/messages.po'),
  lv: () => import('./locales/lv/messages.po'),
  lt: () => import('./locales/lt/messages.po'),
  sq: () => import('./locales/sq/messages.po'),
  be: () => import('./locales/be/messages.po'),
  mk: () => import('./locales/mk/messages.po'),
  bs: () => import('./locales/bs/messages.po'),
  yi: () => import('./locales/yi/messages.po'),
  ne: () => import('./locales/ne/messages.po'),
  si: () => import('./locales/si/messages.po'),
  pa: () => import('./locales/pa/messages.po'),
  gu: () => import('./locales/gu/messages.po'),
  ml: () => import('./locales/ml/messages.po'),
  kn: () => import('./locales/kn/messages.po'),
  mr: () => import('./locales/mr/messages.po'),
  te: () => import('./locales/te/messages.po'),
  ta: () => import('./locales/ta/messages.po'),
  bn: () => import('./locales/bn/messages.po'),
  xh: () => import('./locales/xh/messages.po'),
  zu: () => import('./locales/zu/messages.po'),
  am: () => import('./locales/am/messages.po'),
  ha: () => import('./locales/ha/messages.po'),
  yo: () => import('./locales/yo/messages.po'),
  sw: () => import('./locales/sw/messages.po'),
  af: () => import('./locales/af/messages.po'),
  'nl-be': () => import('./locales/nl-be/messages.po'),
  ms: () => import('./locales/ms/messages.po'),
  is: () => import('./locales/is/messages.po'),
  nb: () => import('./locales/nb/messages.po'),
  fi: () => import('./locales/fi/messages.po'),
  da: () => import('./locales/da/messages.po'),
  hu: () => import('./locales/hu/messages.po'),
  cs: () => import('./locales/cs/messages.po'),
  uk: () => import('./locales/uk/messages.po'),
  ru: () => import('./locales/ru/messages.po'),
  el: () => import('./locales/el/messages.po'),
  vi: () => import('./locales/vi/messages.po'),
  ur: () => import('./locales/ur/messages.po'),
  hi: () => import('./locales/hi/messages.po'),
  it: () => import('./locales/it/messages.po'),
  he: () => import('./locales/he/messages.po'),
  pl: () => import('./locales/pl/messages.po'),
  nl: () => import('./locales/nl/messages.po'),
  sv: () => import('./locales/sv/messages.po'),
  de: () => import('./locales/de/messages.po'),
  'pt-br': () => import('./locales/pt-br/messages.po'),
  pt: () => import('./locales/pt/messages.po'),
  'es-419': () => import('./locales/es-419/messages.po'),
  es: () => import('./locales/es/messages.po'),
  tl: () => import('./locales/tl/messages.po'),
  th: () => import('./locales/th/messages.po'),
  id: () => import('./locales/id/messages.po'),
  ko: () => import('./locales/ko/messages.po'),
  'zh-hant': () => import('./locales/zh-hant/messages.po'),
  'zh-hans': () => import('./locales/zh-hans/messages.po'),
  ar: () => import('./locales/ar/messages.po'),
}

const queryClient = createQueryClient()

const router = createRouter({
  routeTree,
  context: { queryClient },
  basepath: getRouterBasepath(),
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
})

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// Render the app
const rootElement = document.getElementById('root')!
if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nProvider catalogs={catalogs}>
          <ThemeProvider>
            <RouterProvider router={router} />
          </ThemeProvider>

        </I18nProvider>
      </QueryClientProvider>
    </StrictMode>
  )
}
