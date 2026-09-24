import type { Metadata, Viewport } from 'next';
import { Big_Shoulders, Archivo, Lilita_One, Nunito } from 'next/font/google';
import { ThemeProvider } from '@/lib/theme/ThemeProvider';
import { DEFAULT_THEME, STORAGE_KEY } from '@/lib/theme/themes';
import './globals.css';

// All four faces are OFL and self-hosted by next/font at build time (§5, §14.1).
// Google has since renamed "Big Shoulders Display" to plain "Big Shoulders";
// it is the same variable family the design spec names.
const bigShoulders = Big_Shoulders({
  subsets: ['latin'],
  variable: '--font-big-shoulders',
  weight: ['400', '800'],
});
const archivo = Archivo({ subsets: ['latin'], variable: '--font-archivo' });
const lilita = Lilita_One({ subsets: ['latin'], variable: '--font-lilita', weight: '400' });
const nunito = Nunito({ subsets: ['latin'], variable: '--font-nunito' });

export const metadata: Metadata = {
  title: 'This or That',
  description: 'A party game for 2-4 phones, plus the Computer.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fff8f0' },
    { media: '(prefers-color-scheme: dark)', color: '#0d0b1a' },
  ],
  viewportFit: 'cover',
};

/**
 * Applies the stored theme before first paint. Without this the page renders
 * in Duel and snaps to Candy Pop a frame later, which is exactly the kind of
 * flash a party game on a dark phone screen makes obvious.
 */
const themeBootstrap = `
(function () {
  try {
    var stored = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || '{}');
    var theme = stored.theme === 'candy' || stored.theme === 'duel' ? stored.theme : ${JSON.stringify(DEFAULT_THEME)};
    document.documentElement.setAttribute('data-theme', theme);
    if (stored.mode === 'light' || stored.mode === 'dark') {
      document.documentElement.setAttribute('data-mode', stored.mode);
    }
  } catch (e) {
    document.documentElement.setAttribute('data-theme', ${JSON.stringify(DEFAULT_THEME)});
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme={DEFAULT_THEME}
      className={`${bigShoulders.variable} ${archivo.variable} ${lilita.variable} ${nunito.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
